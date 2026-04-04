import os, json, sys
from dotenv import load_dotenv
load_dotenv('/root/.quantumclaw/.env')

from py_clob_client.client import ClobClient

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
balance = client.get_balance()
print(json.dumps({"balance": float(balance)}))
