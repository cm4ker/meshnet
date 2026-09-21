// The parts of the Apple developer account a build needs, through the App Store
// Connect API, so a build on a Mac reached over ssh never needs Xcode's account
// window. Idempotent: run before every archive.
//
//   node scripts/apple.mjs bundle  <identifier> <name> [CAPABILITY...]
//   node scripts/apple.mjs profile <identifier> <profile name>
//
// `bundle` registers the App ID if it is missing and switches on the capabilities
// named (PUSH_NOTIFICATIONS, APP_GROUPS, ...). `profile` makes an App Store
// provisioning profile for it, signed by the Apple Distribution identity in the
// keychain, and installs it where Xcode looks. A profile records the App ID's
// capabilities when it is made, so it is made again every time rather than reused.
//
// Reads ASC_KEY_ID and ASC_ISSUER_ID, and the key from ASC_KEY_PATH or from
// ~/.appstoreconnect/private_keys/AuthKey_<id>.p8, which is where altool looks too.
// Prints nothing it reads from the key or the account beyond names and ids.

import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.appstoreconnect.apple.com/v1";

const keyId = required("ASC_KEY_ID");
const issuerId = required("ASC_ISSUER_ID");
const key = createPrivateKey(
  readFileSync(
    process.env.ASC_KEY_PATH ?? join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${keyId}.p8`),
  ),
);

const [command, identifier, name, ...capabilities] = process.argv.slice(2);

if (command === "bundle" && identifier && name) {
  const bundle = await ensureBundle(identifier, name);
  await ensureCapabilities(bundle, capabilities);
} else if (command === "profile" && identifier && name) {
  await makeProfile(identifier, name);
} else if (command === "app" && identifier) {
  await requireApp(identifier);
} else {
  console.error(
    "usage: apple.mjs bundle <identifier> <name> [CAPABILITY...] | profile <identifier> <profile name> | app <identifier>",
  );
  process.exit(2);
}

/**
 * Whether App Store Connect has an app for the identifier, which an upload needs.
 * The API cannot create one — that is a form on appstoreconnect.apple.com — so a
 * build that would be refused at the end of its upload is refused here instead.
 */
async function requireApp(identifier) {
  const { data } = await api("GET", `/apps?filter[bundleId]=${encodeURIComponent(identifier)}&limit=200`);
  const app = data.find((row) => row.attributes.bundleId === identifier);
  if (!app) {
    console.error(
      `App Store Connect has no app for ${identifier}. Create it once at https://appstoreconnect.apple.com/apps (New App, bundle ID ${identifier}), then run this again.`,
    );
    process.exit(3);
  }
  console.log(`App Store Connect app "${app.attributes.name}" (${app.id})`);
}

async function ensureBundle(identifier, name) {
  const found = await findBundle(identifier);
  if (found) {
    console.log(`App ID ${identifier} is registered`);
    return found;
  }
  const { data } = await api("POST", "/bundleIds", {
    data: { type: "bundleIds", attributes: { identifier, name, platform: "IOS" } },
  });
  console.log(`App ID ${identifier} registered`);
  return data;
}

async function ensureCapabilities(bundle, wanted) {
  if (wanted.length === 0) return;
  const { data } = await api("GET", `/bundleIds/${bundle.id}/bundleIdCapabilities`);
  const have = new Set(data.map((row) => row.attributes.capabilityType));
  for (const capabilityType of wanted) {
    if (have.has(capabilityType)) continue;
    await api("POST", "/bundleIdCapabilities", {
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType },
        relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } } },
      },
    });
    console.log(`${capabilityType} switched on for ${bundle.attributes.identifier}`);
  }
}

async function makeProfile(identifier, name) {
  const bundle = await findBundle(identifier);
  if (!bundle) throw new Error(`App ID ${identifier} is not registered; run bundle first`);

  const certificate = await distributionCertificate();

  // Profiles cannot be edited, and a name is not unique to the account: the old
  // one goes so that the name Xcode is told to use means exactly one profile.
  const { data: old } = await api("GET", `/profiles?filter[name]=${encodeURIComponent(name)}&limit=200`);
  for (const profile of old) await api("DELETE", `/profiles/${profile.id}`);

  const { data } = await api("POST", "/profiles", {
    data: {
      type: "profiles",
      attributes: { name, profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundle.id } },
        certificates: { data: [{ type: "certificates", id: certificate.id }] },
      },
    },
  });

  const directory = join(homedir(), "Library/MobileDevice/Provisioning Profiles");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${data.attributes.uuid}.mobileprovision`);
  writeFileSync(path, Buffer.from(data.attributes.profileContent, "base64"));
  console.log(`profile "${name}" for ${identifier} installed (${data.attributes.uuid})`);
}

/** The account's distribution certificate whose private key is in this Mac's keychain. */
async function distributionCertificate() {
  const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  const local = new Set(
    [...identities.matchAll(/\b([0-9A-F]{40}) "Apple Distribution/g)].map((match) => match[1]),
  );
  if (local.size === 0) throw new Error("no Apple Distribution identity in the keychain");

  const { data } = await api("GET", "/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=200");
  const match = data.find((row) =>
    local.has(
      createHash("sha1")
        .update(Buffer.from(row.attributes.certificateContent, "base64"))
        .digest("hex")
        .toUpperCase(),
    ),
  );
  if (!match) throw new Error("the keychain's distribution identity is not one of the account's certificates");
  return match;
}

async function findBundle(identifier) {
  // The filter matches on a prefix as well, so `dev.x.app` also finds `dev.x.app.widget`.
  const { data } = await api("GET", `/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`);
  return data.find((row) => row.attributes.identifier === identifier) ?? null;
}

async function api(method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return {};
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (json.errors ?? []).map((error) => `${error.title}: ${error.detail}`).join("; ");
    throw new Error(`${method} ${path.split("?")[0]} answered ${response.status}${detail ? ` (${detail})` : ""}`);
  }
  return json;
}

function token() {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({
    iss: issuerId,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${signature.toString("base64url")}`;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return value;
}
