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

FIRST. At the 7-point edge floor the condition needs price * (1 - price) <= 0.035.
That inequality has TWO roots, and both are stated here deliberately, because an
earlier version of this derivation reported only one of them and the other is
where an error lived:

    price <= 0.036319    excluded by the 0.10 sizing price floor
    price >= 0.963681    excluded for a DIFFERENT reason, see below

The upper root is not a feasible region. At price 0.963681 the largest edge that
can exist is 1 - price = 0.036319, so an edge of 0.07 is unreachable there: the
root solves the inequality while violating the constraint edge <= 1 - price. An
earlier audit reported that root as the surviving region. It is the opposite.
Nothing sized at the minimum qualifying edge can be placed at any price.

SECOND. Edge can never exceed (1 - price), since that is the whole payoff.
Requiring edge >= 2 * price * (1 - price) therefore requires 2 * price <= 1, so
ABOVE PRICE 0.5 THE MINIMUM IS UNREACHABLE AT ANY EDGE, INCLUDING CERTAINTY.
Deep favourites are the region that is arithmetically impossible, not the region
that survives.

The exact cut is 0.482521, not 0.5. 0.5 is the FEE-FREE answer; including the
fee the condition is

    2 * price * (1 + 0.07 * (1 - price)) <= 1
    0.14 * price^2 - 2.14 * price + 1 >= 0
    price <= 0.482521

Both numbers are correct for their own model and they are not interchangeable.
The code is fee-aware, so 0.482521 is the one that describes it, and it is the
only one quoted elsewhere.

What survives is a narrow band: price in [0.10, 0.482521] with a very large
edge. The minimum simulated probability that clears 5 shares, from this
implementation:

    price   0.10   0.15   0.20   0.25   0.30   0.35   0.40   0.45   0.4825
    p_min   0.291  0.420  0.538  0.645  0.741  0.826  0.900  0.964  1.000

For comparison, the largest edge in the four historical positions was 0.336 at
price 0.279, which needed 0.4226. (An earlier version of this docstring said
0.395. That number is wrong and is reproducible by no formula here; it appears
to be a transcription of min_notional = 5 * 0.279 = 1.395.)

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
    notional: float           # what the relay is told to spend (amount_usdc),
                              # in WHOLE CENTS, see maker_amount()
    debit: float              # what actually leaves the wallet, notional + fee
    shares: float             # notional / fill_price
    required_shares: float    # the exchange's orderMinSize for this market
    side_price: float         # quoted price of the side being bought
    fill_price: float         # price the order FILLS at: the marginal ask when
                              # the caller walked the book, else side_price
    edge: float               # true_prob - side_price, for the side being bought
    kelly_fraction: float     # fraction of bankroll after KELLY_FRACTION scaling
    kelly_debit: float        # debit Kelly asked for, before any clamp
    clamped_by: Optional[str] # set when the hard ceiling bound the size down
    min_notional: float       # required_shares * fill_price
    min_debit: float          # the same, including fee

    def log_fields(self) -> str:
        """One line carrying every number a later capital decision needs."""
        # sized_notional, not "kelly_notional": this is the figure AFTER any
        # clamp, and the pre-clamp Kelly ask is kelly_debit. The two differ
        # whenever clamped_by is set, and the old label named the wrong one.
        return (
            f"price={self.side_price:.4f} fill_price={self.fill_price:.4f} "
            f"edge={self.edge:+.4f} "
            f"kelly_f={self.kelly_fraction:.5f} kelly_debit={self.kelly_debit:.4f} "
            f"sized_notional={self.notional:.4f} debit={self.debit:.4f} "
            f"shares={self.shares:.4f} required_shares={self.required_shares:.4f} "
            f"min_notional={self.min_notional:.4f} min_debit={self.min_debit:.4f} "
            f"clamped_by={self.clamped_by or 'none'}"
        )


def _refused(reason: str, **kw) -> PositionSizing:
    base = dict(
        tradeable=False, refusal=reason, notional=0.0, debit=0.0, shares=0.0,
        required_shares=0.0, side_price=0.0, fill_price=0.0, edge=0.0, kelly_fraction=0.0,
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


def maker_amount(notional: float) -> float:
    """The whole-cent amount the CLOB client will actually submit for `notional`.

    py-clob-client-v2 1.1.0, the version the relay pins, builds a market BUY as
    round_down(amount, 2) / marginal_ask, where round_down is
    floor(x * 100) / 100 in IEEE doubles. That floor has a float hazard:
    0.29 * 100 is 28.999999999999996, so round_down(0.29, 2) is 0.28, and 0.58
    goes to 0.57 and then to 0.56. Applying the floor here once is therefore
    not enough, because the value this function returns is what gets SENT, and
    the client floors it again on arrival: a value that is not a fixed point of
    the floor loses a cent on the way through and the share count checked here
    is not the one the exchange computes.

    So this iterates to the fixed point: the returned value satisfies
    round_down(value, 2) == value, which is the only way "what we send", "what
    GATE 8 walks" (it applies the client's single floor to amount_usdc) and
    "what the client submits" are the same number. Never rounds up; a notional
    under a cent is 0.0, which no minimum admits.
    """
    value = float(notional)
    if not math.isfinite(value) or value <= 0:
        return 0.0
    for _ in range(8):
        floored = math.floor(value * 100.0) / 100.0
        if floored == value:
            return value
        value = floored
    return value


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
    absolute_max_usdc: Optional[float] = None,
    fill_price: Optional[float] = None,
) -> PositionSizing:
    """Size one trade, or refuse it with a reason.

    `min_order_size` is the market's own `orderMinSize`, read live rather than
    hardcoded: it is a remote value and baking in a copy is the manual-allowlist
    pattern this codebase has been bitten by repeatedly. None means it could not
    be read, and that FAILS CLOSED.

    `max_position_usdc` bounds the DEBIT, not the notional. It sits ABOVE Kelly
    and only ever binds downward; when it binds, `clamped_by` records it.

    `fill_price` is the price the order would actually FILL at: the marginal ask
    from walking the live book for this notional, which is what executor GATE 8
    divides by. When the caller has it, the share count, the two minima and the
    fee are computed against it, so the scanner's verdict is the gate's verdict
    on the same book. When it is None the quoted `side_price` stands in, which
    is a first pass only: across 24 live markets the ask ran a median of 1.8%
    and a maximum of 22% above Gamma's quote, and three quoted ABOVE the ask, so
    no verdict at the quoted price should be shown to a human. Kelly itself is
    NOT re-run at the fill price: the notional is the budget for the edge that
    was measured at the quote, and letting the fill move the notional would move
    the walk that produced the fill.
    """
    # Inputs first, so a refusal never carries arithmetic derived from garbage.
    for name, value in (("sim_probability", sim_probability), ("yes_price", yes_price)):
        if value is None or not isinstance(value, (int, float)) or isinstance(value, bool) \
                or not math.isfinite(float(value)):
            return _refused("invalid_input")
    if not 0.0 < float(yes_price) < 1.0:
        return _refused("invalid_price")
    # A fill price is remote data too (it comes off the CLOB book), so it gets
    # the same treatment as yes_price rather than being trusted as a float.
    if fill_price is not None and (
        not isinstance(fill_price, (int, float)) or isinstance(fill_price, bool)
        or not math.isfinite(float(fill_price)) or not 0.0 < float(fill_price) < 1.0
    ):
        return _refused("invalid_fill_price")
    # A PROBABILITY, so range-checked and not merely finite. The whole
    # "impossible above price 0.5" result rests on edge <= 1 - price, which
    # rests on p <= 1; nothing upstream enforced it and the Monte Carlo worker
    # is a remote HTTP service with no asserted response schema. Measured before
    # this check existed: p = 1.05 at price 0.98 returned a TRADEABLE $8.74
    # notional, inside the region this module calls arithmetically impossible.
    # The old linear ramp clamped every input to $10 no matter what; Kelly is
    # linear in the edge, so the same unit slip now runs to the ceiling.
    if not 0.0 <= float(sim_probability) <= 1.0:
        return _refused("invalid_probability")
    if min_order_size is None or not math.isfinite(float(min_order_size)) \
            or float(min_order_size) <= 0:
        # Fail closed. An unknown exchange minimum is refused, never assumed to
        # be 5, and never assumed to be satisfied.
        return _refused("unknown_min_order_size")
    if not math.isfinite(float(bankroll)) or bankroll <= 0:
        return _refused("invalid_bankroll")
    # A negative fraction produced a NEGATIVE notional refused as
    # "below_exchange_minimum", which is the wrong diagnosis in the refusal logs
    # decision (c) is meant to be mined from. GATE 5 caught the negative amount,
    # so it was fail-closed and mislabelled rather than dangerous.
    if not math.isfinite(float(kelly_fraction)) or kelly_fraction <= 0:
        return _refused("invalid_kelly_fraction")

    price = side_price_for(direction, float(yes_price))
    # What the order fills at. The minima, the share count and the fee are all
    # functions of THIS price, because it is the one the exchange uses.
    fill = float(fill_price) if fill_price is not None else price
    true_prob = float(sim_probability) if str(direction).upper() == "YES" \
        else 1.0 - float(sim_probability)
    edge = true_prob - price
    required = float(min_order_size)
    min_notional = required * fill
    min_debit = min_notional * (1.0 + fee_ratio(fill))

    common = dict(
        side_price=price, fill_price=fill, edge=edge, required_shares=required,
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

    # Size against the ceiling the executor actually ENFORCES FIRST. GATE 5
    # checks trading_config.max_position_usdc (live value 10) before the hard
    # ABSOLUTE_MAX_POSITION_USDC (25), so sizing against 25 could propose a $12
    # position, show that number to a human, and have GATE 5 refuse it after
    # approval. Same class as the approval-path guard: never put a figure in
    # front of someone that the system will not honour.
    ceiling = max_position_usdc
    ceiling_name = "max_position_usdc"
    if absolute_max_usdc is not None and absolute_max_usdc < ceiling:
        ceiling, ceiling_name = absolute_max_usdc, "absolute_max_position_usdc"

    cap = kelly_debit
    clamped_by = None
    if cap > ceiling:
        cap = ceiling
        clamped_by = ceiling_name

    # Size on the DEBIT: the wallet pays notional + fee, so solve for the
    # notional whose debit equals the cap, at the quoted price the edge was
    # measured against.
    #
    # FLOOR TO WHOLE CENTS FIRST, to the fixed point of the client's own floor,
    # and derive shares and debit from THAT figure. The relay hands amount_usdc
    # to py-clob-client-v2, which submits round_down(amount, 2) / marginal_ask.
    # An earlier version of this comment said the relay is sent a 6dp-rounded
    # notional and the exchange divides that by price; it is not and it does
    # not. Sizing at 6dp produced sub-cent notionals as a matter of course, so
    # the share count checked here was systematically above the one the
    # exchange computed, and at the boundary that is the difference between a
    # clean refusal and an order the exchange rejects after a human approved it.
    # Executor GATE 8 applies the identical floor to amount_usdc, so the two
    # agree by construction rather than by coincidence.
    notional = maker_amount(cap / (1.0 + fee_ratio(price)))
    shares = notional / fill
    debit = notional * (1.0 + fee_ratio(fill))

    sized = dict(
        common, notional=notional, debit=round(debit, 6),
        shares=shares, kelly_fraction=fraction, kelly_debit=kelly_debit,
        clamped_by=clamped_by,
    )

    # STRICTLY less than. Exactly the minimum is ADMITTED, and GATE 8 makes the
    # same comparison on the same two numbers: the whole-cent notional divided
    # by the marginal ask, against the exchange's minimum. The scanner supplies
    # `fill_price` from the same book walk GATE 8 performs, so a trade the
    # scanner sizes is refused at execution only if the book moved in between,
    # never for a reason the scanner did not anticipate. Without a fill price
    # the quoted price stands in, and that verdict is provisional: the scanner
    # re-runs this against the book before anything is proposed. Mutants moving
    # this boundary either way, including admitting 1% under, survived the
    # suite until it was pinned on both sides.
    if shares < required:
        # NEVER round up to reach the minimum. Rounding up would abandon the
        # only property Kelly provides, which is that the stake is proportional
        # to the edge; a stake raised to clear an exchange floor is a stake
        # chosen by the exchange.
        return PositionSizing(tradeable=False, refusal="below_exchange_minimum", **sized)

    return PositionSizing(tradeable=True, refusal=None, **sized)
