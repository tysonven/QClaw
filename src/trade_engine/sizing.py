#!/usr/bin/env python3
"""Fractional-Kelly position sizing, fee-aware, and the exchange minimum.

Pure. No network, no config import, no logging. Everything is passed in, so the
arithmetic can be tested directly and so the scanner and executor GATE 8 can run
the SAME function against different inputs, the way horizon.py serves the
scanner and GATE 7.

WHAT REPLACED WHAT
------------------
Until 2026-09-08 size was a linear ramp on edge: $3 at a 7-point edge rising to
$10 at 15 points, floored at $3. It had no relationship to bankroll, to the
probability estimate's confidence, or to what the trade could lose. It also
sized the NOTIONAL while the wallet is debited notional PLUS fee, so every
position quietly overspent its own ceiling.

THE THREE THINGS THIS GETS RIGHT
--------------------------------
1. Kelly, fractionally. For a binary contract bought at `side_price` with true
   probability `true_prob`, the full-Kelly fraction of bankroll is
   (true_prob - side_price) / (1 - side_price). KELLY_FRACTION scales it down.
   Kelly ONLY sizes down from the configured maximum; it can never size up.

2. The fee. fee = 0.07 * price * (1 - price) * shares, equivalently
   fee / notional = 0.07 * (1 - price). Verified against the 2026-08-20 receipt:
   10.501189 debited against 10.00 notional at price 0.284 is a ratio of
   1.05012, against a predicted 1 + 0.07 * 0.716 = 1.05012. So sizing to a cap
   means notional = cap / (1 + 0.07 * (1 - price)), and the CAP IS THE DEBIT.

3. The exchange minimum, which is in SHARES and is the reason most trades will
   now be refused rather than resized. See the module note below.

WHY ALMOST NOTHING WILL TRADE, AND WHY THAT IS CORRECT
------------------------------------------------------
Polymarket enforces a per-market minimum order size in SHARES (`orderMinSize`,
5 on every market sampled 2026-09-08), server-side:

    order 0x... is invalid. Size (1.08) lower than the minimum: 5

Ignoring the fee term, clearing that minimum requires

    shares = KELLY_FRACTION * bankroll * edge / (price * (1 - price)) >= 5
    i.e.    edge >= 2 * price * (1 - price)        at KELLY_FRACTION * bankroll = 2.5

Two consequences, and the second is the one that surprises.

At the 7-point edge floor the condition needs price * (1 - price) <= 0.035, so
price <= 0.036, which the 0.10 sizing floor excludes. NOTHING sized at the
minimum qualifying edge can ever be placed.

And edge can never exceed (1 - price), since that is the payoff. Requiring
edge >= 2 * price * (1 - price) therefore requires 2 * price <= 1. **Above
price 0.5 the minimum is unreachable at ANY edge, including certainty.** At
p = 1 the notional collapses to KELLY_FRACTION * bankroll = $2.50 whatever the
price, so shares = 2.50 / price, which crosses 5 at price 0.48. Deep favourites
are the one region that is arithmetically impossible, not the region that
survives.

What survives is a narrow band: price in [0.10, ~0.48] with a very large edge.
Measured against this implementation, the minimum simulated probability that
clears 5 shares is 0.29 at price 0.10, 0.54 at 0.20, 0.74 at 0.30, 0.90 at 0.40
and 0.96 at 0.45. For comparison, the largest edge in the four historical
positions was 0.336 at price 0.279, which needed 0.395.

That is arithmetic, not a tuning error. At a $25 bankroll the exchange's share
granularity is coarser than the entire Kelly budget. NEVER "fix" this by raising
bankroll_usdc: that number came from $29.24 of MEASURED spendable collateral,
and raising it to the ~$180 that would make Kelly and the exchange compatible at
mid prices would size against money that does not exist, which is exactly what
turns Kelly from conservative into dangerous. Making that work is a CAPITAL
decision, a deposit of about $155, not a config edit.

A system that sizes correctly and therefore almost never trades is behaving
properly. The model was 7x wrong six weeks ago. Suppression is the discipline
working, and every refusal is logged with its numbers so the suppression rate
becomes data for the capital decision rather than a guess.
"""

from __future__ import annotations

import math
from typing import NamedTuple, Optional

# Polymarket's taker fee coefficient. fee = FEE_RATE * p * (1-p) * shares.
# One fee mechanism, not two (build log 2026-09-05). Verified to 4dp against a
# real settlement receipt; see the module docstring.
FEE_RATE = 0.07


class PositionSizing(NamedTuple):
    """A sizing decision, with everything needed to log why.

    `tradeable` is the only field callers should branch on. The rest exists so a
    refusal can be recorded with its arithmetic rather than as a bare reason
    string: the whole point of (c) is to measure how often, and at what prices,
    correct sizing lands under the exchange floor.
    """

    tradeable: bool
    refusal: Optional[str]
    notional: float           # what the relay is told to spend (amount_usdc)
    debit: float              # what actually leaves the wallet, notional + fee
    shares: float             # notional / side_price
    required_shares: float    # the exchange's orderMinSize for this market
    side_price: float         # price of the side being bought
    edge: float               # true_prob - side_price, for the side being bought
    kelly_fraction: float     # fraction of bankroll after KELLY_FRACTION scaling
    kelly_debit: float        # debit Kelly asked for, before any clamp
    clamped_by: Optional[str] # set when the hard ceiling bound the size down
    min_notional: float       # required_shares * side_price
    min_debit: float          # the same, including fee

    def log_fields(self) -> str:
        """One line carrying every number a later capital decision needs."""
        return (
            f"price={self.side_price:.4f} edge={self.edge:+.4f} "
            f"kelly_f={self.kelly_fraction:.5f} kelly_notional={self.notional:.4f} "
            f"debit={self.debit:.4f} shares={self.shares:.4f} "
            f"required_shares={self.required_shares:.4f} "
            f"min_notional={self.min_notional:.4f} min_debit={self.min_debit:.4f}"
        )


def _refused(reason: str, **kw) -> PositionSizing:
    base = dict(
        tradeable=False, refusal=reason, notional=0.0, debit=0.0, shares=0.0,
        required_shares=0.0, side_price=0.0, edge=0.0, kelly_fraction=0.0,
        kelly_debit=0.0, clamped_by=None, min_notional=0.0, min_debit=0.0,
    )
    base.update(kw)
    return PositionSizing(**base)


def fee_ratio(side_price: float) -> float:
    """fee / notional for a market bought at `side_price`.

    Depends only on price, which is why MAX_CASH_OUT_NOTIONAL_FACTOR can be
    computed per trade instead of held at a flat worst-case constant.
    """
    return FEE_RATE * (1.0 - side_price)


def side_price_for(direction: str, yes_price: float) -> float:
    """Price of the side actually being bought.

    The old sizing used abs(edge) and apologised for it in a docstring. Buying
    NO at (1 - yes_price) with true probability (1 - p) is the same Kelly
    problem with both terms complemented, so sizing it correctly costs one line
    and removes the hack. best_trade only ever comes from the high-edge bucket
    today, so the NO branch is unreachable from the scanner; it is correct
    rather than dead because nothing should have to remember that.
    """
    return yes_price if str(direction).upper() == "YES" else 1.0 - yes_price


def size_position(
    *,
    sim_probability: float,
    yes_price: float,
    direction: str,
    min_order_size: Optional[float],
    bankroll: float,
    kelly_fraction: float,
    max_position_usdc: float,
    price_floor: float,
) -> PositionSizing:
    """Size one trade, or refuse it with a reason.

    `min_order_size` is the market's own `orderMinSize`, read live rather than
    hardcoded: it is a remote value and baking in a copy is the manual-allowlist
    pattern this codebase has been bitten by repeatedly. None means it could not
    be read, and that FAILS CLOSED.

    `max_position_usdc` bounds the DEBIT, not the notional. It sits ABOVE Kelly
    and only ever binds downward; when it binds, `clamped_by` records it.
    """
    # Inputs first, so a refusal never carries arithmetic derived from garbage.
    for name, value in (("sim_probability", sim_probability), ("yes_price", yes_price)):
        if value is None or not isinstance(value, (int, float)) or isinstance(value, bool) \
                or not math.isfinite(float(value)):
            return _refused("invalid_input")
    if not 0.0 < float(yes_price) < 1.0:
        return _refused("invalid_price")
    if min_order_size is None or not math.isfinite(float(min_order_size)) \
            or float(min_order_size) <= 0:
        # Fail closed. An unknown exchange minimum is refused, never assumed to
        # be 5, and never assumed to be satisfied.
        return _refused("unknown_min_order_size")
    if not math.isfinite(float(bankroll)) or bankroll <= 0:
        return _refused("invalid_bankroll")

    price = side_price_for(direction, float(yes_price))
    true_prob = float(sim_probability) if str(direction).upper() == "YES" \
        else 1.0 - float(sim_probability)
    edge = true_prob - price
    required = float(min_order_size)
    min_notional = required * price
    min_debit = min_notional * (1.0 + fee_ratio(price))

    common = dict(
        side_price=price, edge=edge, required_shares=required,
        min_notional=min_notional, min_debit=min_debit,
    )

    # The sizing price floor is a PROPOSAL filter and is deliberately separate
    # from YES_PRICE_MIN, which governs inclusion. Sub-floor markets are still
    # scanned, simulated and reported; they are just never sized or proposed,
    # which keeps the question answerable from data later.
    if price < price_floor:
        return _refused("price_below_sizing_floor", **common)

    if edge <= 0:
        # Kelly says do not bet. Not an error; the no-edge bucket lands here.
        return _refused("no_positive_edge", **common)

    full_kelly = edge / (1.0 - price)
    fraction = kelly_fraction * full_kelly
    kelly_debit = fraction * bankroll

    cap = kelly_debit
    clamped_by = None
    if cap > max_position_usdc:
        cap = max_position_usdc
        clamped_by = "max_position_usdc"

    # Size on the DEBIT: the wallet pays notional + fee, so solve for the
    # notional whose debit equals the cap.
    #
    # Round FIRST, then derive shares and debit from the rounded figure. The
    # rounded notional is what is actually sent to the relay, so it is what the
    # exchange divides by price to get the order size; deriving shares from the
    # unrounded value would mean the share count checked against the minimum is
    # not the share count the exchange computes. At the boundary that is the
    # difference between a refusal and a rejected order.
    notional = round(cap / (1.0 + fee_ratio(price)), 6)
    shares = notional / price
    debit = notional * (1.0 + fee_ratio(price))

    sized = dict(
        common, notional=notional, debit=round(debit, 6),
        shares=shares, kelly_fraction=fraction, kelly_debit=kelly_debit,
        clamped_by=clamped_by,
    )

    if shares < required:
        # NEVER round up to reach the minimum. Rounding up would abandon the
        # only property Kelly provides, which is that the stake is proportional
        # to the edge; a stake raised to clear an exchange floor is a stake
        # chosen by the exchange.
        return PositionSizing(tradeable=False, refusal="below_exchange_minimum", **sized)

    return PositionSizing(tradeable=True, refusal=None, **sized)
