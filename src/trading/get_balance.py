import os, json, sys, urllib.request
from dotenv import load_dotenv
load_dotenv('/root/.quantumclaw/.env')

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import BalanceAllowanceParams, AssetType

key = os.getenv('POLYMARKET_PRIVATE_KEY')
funder = os.getenv('POLYMARKET_FUNDER_ADDRESS')

client = ClobClient(
    "https://clob.polymarket.com",
    key=key,
    chain_id=137,
    signature_type=1,
    funder=funder
)
client.set_api_creds(client.create_or_derive_api_creds())

# CLOB exchange balance (deposited USDC)
params = BalanceAllowanceParams(asset_type=AssetType.COLLATERAL, signature_type=1)
result = client.get_balance_allowance(params)
clob_balance = float(result.get("balance", 0)) / 1e6

# On-chain USDC balance (Polygon)
wallet_balance = 0.0
if funder:
    padded = funder[2:].lower().zfill(64)
    payload = json.dumps({
        "jsonrpc": "2.0", "method": "eth_call", "id": 1,
        "params": [{"to": "0x3c499c542cef5e3811e1192ce70d8cC03d5c3359",
                     "data": "0x70a08231000000000000000000000000" + padded}, "latest"]
    }).encode()
    req = urllib.request.Request("https://polygon-rpc.com", data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        rpc = json.load(r)
    if rpc.get("result"):
        wallet_balance = int(rpc["result"], 16) / 1e6

print(json.dumps({"balance": round(clob_balance + wallet_balance, 2), "clob": round(clob_balance, 2), "wallet": round(wallet_balance, 2)}))
