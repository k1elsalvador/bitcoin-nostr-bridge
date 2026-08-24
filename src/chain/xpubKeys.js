import * as btc from "bitcoinjs-lib";
import ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory } from "bip32";

const bip32 = BIP32Factory(ecc);

const BASE_NETWORKS = {
  bitcoin: btc.networks.bitcoin,
  testnet: btc.networks.testnet,
  regtest: btc.networks.regtest,
};

// BIP32 extended-key version bytes per script type/network. bip32.fromBase58
// validates the key's prefix against network.bip32.public, so each prefix
// needs its own network object even though they share the same base network
// otherwise (address encoding, wif, etc. are unaffected by this and use the
// underlying BASE_NETWORKS entry instead).
const VERSION_BYTES = {
  bitcoin: {
    xpub: { public: 0x0488b21e, private: 0x0488ade4, scriptType: "p2pkh" },
    ypub: { public: 0x049d7cb2, private: 0x049d7878, scriptType: "p2sh-p2wpkh" },
    zpub: { public: 0x04b24746, private: 0x04b2430c, scriptType: "p2wpkh" },
  },
  testnet: {
    tpub: { public: 0x043587cf, private: 0x04358394, scriptType: "p2pkh" },
    upub: { public: 0x044a5262, private: 0x044a4e28, scriptType: "p2sh-p2wpkh" },
    vpub: { public: 0x045f1cf6, private: 0x045f18bc, scriptType: "p2wpkh" },
  },
};
VERSION_BYTES.regtest = VERSION_BYTES.testnet;

/**
 * Parses an xpub/ypub/zpub (or testnet tpub/upub/vpub) account-level extended
 * public key into a BIP32 node plus the script type its prefix implies, and
 * returns a deriveAddress(chain, index) function — chain 0 = external/receive,
 * 1 = internal/change, matching BIP44/49/84 convention.
 */
export function parseExtendedPubkey(xpubStr, networkName = "bitcoin") {
  const baseNetwork = BASE_NETWORKS[networkName];
  if (!baseNetwork) throw new Error(`Unknown network: ${networkName}`);

  const prefix = xpubStr.slice(0, 4);
  const table = VERSION_BYTES[networkName];
  const entry = table?.[prefix];
  if (!entry) {
    const known = Object.keys(table ?? {}).join("/");
    throw new Error(`Unrecognized extended pubkey prefix "${prefix}" (expected one of: ${known})`);
  }

  const keyNetwork = { ...baseNetwork, bip32: { public: entry.public, private: entry.private } };
  let node;
  try {
    node = bip32.fromBase58(xpubStr, keyNetwork);
  } catch (err) {
    throw new Error(`Invalid extended pubkey: ${err.message}`);
  }
  if (node.privateKey) {
    throw new Error("Expected a public extended key (xpub/ypub/zpub), got a private one");
  }
  if (node.depth !== 3) {
    // BIP44/49/84 account-level keys are always depth 3 (m/purpose'/coin'/account').
    // A depth-0 master or a receive/change-level key would silently scan the
    // wrong tree if allowed through.
    throw new Error(
      `Expected an account-level extended pubkey (BIP44/49/84 depth 3), got depth ${node.depth}`,
    );
  }

  function deriveAddress(chain, index) {
    const child = node.derive(chain).derive(index);
    const pubkey = Buffer.from(child.publicKey);
    let payment;
    switch (entry.scriptType) {
      case "p2pkh":
        payment = btc.payments.p2pkh({ pubkey, network: baseNetwork });
        break;
      case "p2sh-p2wpkh":
        payment = btc.payments.p2sh({
          redeem: btc.payments.p2wpkh({ pubkey, network: baseNetwork }),
          network: baseNetwork,
        });
        break;
      case "p2wpkh":
        payment = btc.payments.p2wpkh({ pubkey, network: baseNetwork });
        break;
      default:
        throw new Error(`Unhandled script type: ${entry.scriptType}`);
    }
    return { address: payment.address, path: `${chain}/${index}` };
  }

  return { scriptType: entry.scriptType, deriveAddress };
}
