import type { Company } from "./types";

/**
 * The watch list.
 *
 * Every slug here was confirmed to answer with live postings before it was
 * added — a guessed slug returns an empty array and looks exactly like a
 * company with nothing open, which is the worst kind of silence. To add a
 * company, find its board and check it returns jobs, then add one row.
 *
 *   greenhouse       boards-api.greenhouse.io/v1/boards/SLUG/jobs
 *   lever            api.lever.co/v0/postings/SLUG?mode=json
 *   ashby            api.ashbyhq.com/posting-api/job-board/SLUG
 *   smartrecruiters  api.smartrecruiters.com/v1/companies/SLUG/postings
 *   successfactors   https://HOST/sitemap.xml
 */
export const COMPANIES: Company[] = [
  // --- Indian product companies and unicorns ---
  { name: "Paytm", via: "lever", slug: "paytm" },
  { name: "Swiggy", via: "smartrecruiters", slug: "swiggy" },
  { name: "Meesho", via: "lever", slug: "meesho" },
  { name: "CRED", via: "lever", slug: "cred" },
  { name: "Groww", via: "greenhouse", slug: "groww" },
  { name: "Freshworks", via: "smartrecruiters", slug: "freshworks" },
  { name: "Unacademy", via: "smartrecruiters", slug: "unacademy" },
  { name: "Navi", via: "ashby", slug: "navi" },
  { name: "slice", via: "greenhouse", slug: "slice" },
  { name: "Turing", via: "greenhouse", slug: "turing" },

  // --- Indian IT services ---
  { name: "HCLTech", via: "successfactors", slug: "careers.hcltech.com" },

  // --- Global product companies that hire in India ---
  { name: "Databricks", via: "greenhouse", slug: "databricks" },
  { name: "Stripe", via: "greenhouse", slug: "stripe" },
  { name: "Datadog", via: "greenhouse", slug: "datadog" },
  { name: "Cloudflare", via: "greenhouse", slug: "cloudflare" },
  { name: "Elastic", via: "greenhouse", slug: "elastic" },
  { name: "MongoDB", via: "greenhouse", slug: "mongodb" },
  { name: "GitLab", via: "greenhouse", slug: "gitlab" },
  { name: "Figma", via: "greenhouse", slug: "figma" },
  { name: "Twilio", via: "greenhouse", slug: "twilio" },
  { name: "Dropbox", via: "greenhouse", slug: "dropbox" },
  { name: "Airtable", via: "greenhouse", slug: "airtable" },
  { name: "Workato", via: "greenhouse", slug: "workato" },
  { name: "Snowflake", via: "ashby", slug: "snowflake" },
  { name: "Notion", via: "ashby", slug: "notion" },
  { name: "Confluent", via: "ashby", slug: "confluent" },
  { name: "ServiceNow", via: "smartrecruiters", slug: "servicenow" },
  { name: "Canva", via: "smartrecruiters", slug: "canva" },
];
