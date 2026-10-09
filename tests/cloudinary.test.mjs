// Signing uploads for Cloudinary, and reading its config.
import { createHash } from "node:crypto";

const { cloudinaryConfig, cloudinaryConfigured, resumePublicId, signParams, signatureBase } =
  await import("./.cloudinary.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

const KEYS = [
  "CLOUDINARY_URL",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "CLOUDINARY_FOLDER",
];
const clear = () => KEYS.forEach((k) => delete process.env[k]);

section("reading the config");
clear();
check("nothing configured is not an error", cloudinaryConfig(), null);
check("and it says so", cloudinaryConfigured(), false);

clear();
process.env.CLOUDINARY_URL = "cloudinary://123456789012345:abcDEF_secret-123@my-cloud";
const fromUrl = cloudinaryConfig();
check("the single URL gives the key", fromUrl.apiKey, "123456789012345");
check("and the secret", fromUrl.apiSecret, "abcDEF_secret-123");
check("and the cloud name", fromUrl.cloudName, "my-cloud");
check("with the default folder", fromUrl.folder, "jdmailer/resumes");

clear();
process.env.CLOUDINARY_CLOUD_NAME = "my-cloud";
process.env.CLOUDINARY_API_KEY = "999";
process.env.CLOUDINARY_API_SECRET = "shh";
check("three separate variables work too", cloudinaryConfig().cloudName, "my-cloud");
// One of three is not a config, and half-applying it would fail at upload
// time with a 401 rather than here.
delete process.env.CLOUDINARY_API_SECRET;
check("two out of three is not enough", cloudinaryConfig(), null);

clear();
process.env.CLOUDINARY_URL = "cloudinary://1:2@from-url";
process.env.CLOUDINARY_CLOUD_NAME = "from-parts";
process.env.CLOUDINARY_API_KEY = "1";
process.env.CLOUDINARY_API_SECRET = "2";
check("the URL wins when both are set", cloudinaryConfig().cloudName, "from-url");

clear();
process.env.CLOUDINARY_URL = "https://cloudinary.com/console";
check("a URL that is not a cloudinary:// one is ignored", cloudinaryConfig(), null);

clear();
process.env.CLOUDINARY_URL = "cloudinary://1:2@my-cloud";
process.env.CLOUDINARY_FOLDER = "/resumes/chirag/";
check("stray slashes are trimmed off the folder", cloudinaryConfig().folder, "resumes/chirag");

section("the string Cloudinary signs");
// The exclusions and the sort order are the whole risk here: get either
// wrong and the account answers 401 without naming the parameter.
check(
  "parameters are sorted by name",
  signatureBase({ timestamp: 1, public_id: "a", eager: "b" }),
  "eager=b&public_id=a&timestamp=1",
);
check("the file itself is never signed", signatureBase({ file: "data:...", timestamp: 1 }), "timestamp=1");
check("nor the api key", signatureBase({ api_key: "9", timestamp: 1 }), "timestamp=1");
check("nor the cloud name", signatureBase({ cloud_name: "c", timestamp: 1 }), "timestamp=1");
check("nor the resource type", signatureBase({ resource_type: "raw", timestamp: 1 }), "timestamp=1");
check("nor a signature already there", signatureBase({ signature: "x", timestamp: 1 }), "timestamp=1");
check("empty values are left out", signatureBase({ folder: "", timestamp: 1 }), "timestamp=1");
check("nothing to sign is an empty string", signatureBase({}), "");

section("the signature");
// Computed here from first principles rather than compared against a
// recorded value, so this checks what we build and hash, not that SHA-1
// is still SHA-1.
const params = { public_id: "jdmailer/resumes/resume-aabbcc.pdf", timestamp: 1700000000 };
const expected = createHash("sha1")
  .update(`public_id=${params.public_id}&timestamp=${params.timestamp}` + "my-secret")
  .digest("hex");
check("is sha1 of the sorted params plus the secret", signParams(params, "my-secret"), expected);
check("is 40 hex characters", /^[0-9a-f]{40}$/.test(signParams(params, "my-secret")), true);
// A different secret must not produce the same signature.
check("depends on the secret", signParams(params, "other") === expected, false);

section("the name the file is stored under");
const id = resumePublicId("Chirag Kashyap Resume.pdf", "jdmailer/resumes");
check("it sits in the folder", id.startsWith("jdmailer/resumes/"), true);
check("the name is slugged", id.includes("chirag-kashyap-resume-"), true);
// Raw files carry no extension unless the id has one, and a mail client
// then has to guess what it downloaded.
check("it keeps the extension", id.endsWith(".pdf"), true);
// A resume is a phone number and an address, and a raw URL is readable by
// anyone holding it, so the name must not be guessable from the folder.
check("it ends in random hex", /-[0-9a-f]{12}\.pdf$/.test(id), true);
check("two uploads of one file differ", resumePublicId("cv.pdf", "f") === resumePublicId("cv.pdf", "f"), false);
check("a docx keeps its own extension", resumePublicId("cv.docx", "f").endsWith(".docx"), true);
check("a name with no extension is assumed PDF", resumePublicId("resume", "f").endsWith(".pdf"), true);
check("a name of only punctuation still works", resumePublicId("___.pdf", "f").startsWith("f/resume-"), true);
check("no folder means no leading slash", resumePublicId("cv.pdf", "").startsWith("cv-"), true);
// Public ids are path-like, so a long name must not be allowed to run away.
check("a very long name is cut", resumePublicId(`${"a".repeat(200)}.pdf`, "f").length < 80, true);

clear();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
