export type Profile = {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  headline: string;
  linkedin: string;
  github: string;
  portfolio: string;
  yearsExperience: string;
  skills: string;
  resumeText: string;
  extraNotes: string;
  tone: "warm" | "formal" | "direct";
  signOff: string;
  gmailUser: string;
  gmailAppPassword: string;
  ccSelf: boolean;
  resumeFileName: string;
  /** base64 (no data: prefix) of the resume attachment */
  resumeFileData: string;
  resumeFileType: string;
};

export const EMPTY_PROFILE: Profile = {
  fullName: "",
  email: "",
  phone: "",
  location: "",
  headline: "",
  linkedin: "",
  github: "",
  portfolio: "",
  yearsExperience: "",
  skills: "",
  resumeText: "",
  extraNotes: "",
  tone: "warm",
  signOff: "Best regards",
  gmailUser: "",
  gmailAppPassword: "",
  ccSelf: true,
  resumeFileName: "",
  resumeFileData: "",
  resumeFileType: "",
};

/** One thing the user pasted: a screenshot or a block of text. */
export type SourceItem = {
  id: string;
  kind: "image" | "text";
  /** base64 without the data: prefix, for images */
  data: string;
  mediaType: string;
  text: string;
  /** thumbnail data URL, images only */
  preview: string;
  groupId: string;
};

export type DraftStatus = "idle" | "sending" | "sent" | "error";

/** One email the model wrote, derived from one or more SourceItems. */
export type DraftSource = "ai" | "recipe" | "local";

export type Draft = {
  id: string;
  groupId: string;
  company: string;
  role: string;
  location: string;
  seniority: string;
  reqId: string;
  recipients: string[];
  contactName: string;
  highlights: string[];
  subject: string;
  /** Without the signature — that is appended at preview and send time. */
  body: string;
  /** What was generated, before any editing — the baseline for learning. */
  originalSubject: string;
  originalBody: string;
  confidence: "high" | "medium" | "low";
  notes: string;
  /** How the email text was produced: model, stored recipe, or local rules. */
  source: DraftSource;
  recipeKey: string;
  /** Unticked drafts are skipped by Send all. */
  include: boolean;
  status: DraftStatus;
  error: string;
  sentAt: string;
};

export type ExtractedJob = {
  company: string;
  role: string;
  location: string;
  seniority: string;
  reqId: string;
  recipients: string[];
  contactName: string;
  highlights: string[];
  subject?: string;
  body?: string;
  confidence: "high" | "medium" | "low";
  notes: string;
};
