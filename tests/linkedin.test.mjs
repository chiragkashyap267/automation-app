// Reading a LinkedIn job link, which turns out to be public after all.
const { linkedInJobId, linkedInActivityId, isShortLink, isFeedPost, isReadableLinkedIn, toPlainText,
  extractByClass, ogTag, parseGuestJob, parseEmbeddedPost, parseOgPost, authorFromOgTitle,
  asPostingText, postAsText, classifyShare } =
  await import("./.linkedin.bundle.mjs");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
  ok ? pass++ : fail++;
};
const section = (n) => console.log(`\n-- ${n}`);

section("pulling the job id out of what a share hands over");
check("a plain job url", linkedInJobId("https://www.linkedin.com/jobs/view/4287321907/"), "4287321907");
// This is the shape the share sheet actually produces, and "www." is three
// letters — a two-letter subdomain rule missed every one of them.
check("the slug form with www", linkedInJobId("https://www.linkedin.com/jobs/view/frontend-developer-react-js-at-decodeup-p-limited-4287321907"), "4287321907");
check("a country subdomain", linkedInJobId("https://in.linkedin.com/jobs/view/4447650774"), "4447650774");
check("no subdomain at all", linkedInJobId("https://linkedin.com/jobs/view/4287321907"), "4287321907");
check("with tracking junk on the end", linkedInJobId("https://www.linkedin.com/jobs/view/4287321907/?refId=abc&trk=x"), "4287321907");
check("the guest endpoint itself", linkedInJobId("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4287321907"), "4287321907");

section("links that are not readable jobs");
check("a feed post", linkedInJobId("https://www.linkedin.com/posts/someone_hiring-activity-7123456789"), null);
check("and it is recognised as one", isFeedPost("https://www.linkedin.com/posts/someone_hiring-activity-7123456789"), true);
check("a pulse article", isFeedPost("https://www.linkedin.com/pulse/some-article"), true);
check("a company page", linkedInJobId("https://www.linkedin.com/company/acme"), null);
check("another site entirely", linkedInJobId("https://example.com/jobs/view/4287321907"), null);
check("a job link is not a feed post", isFeedPost("https://www.linkedin.com/jobs/view/4287321907"), false);

section("pulling the activity id out of a feed post link");
// This is what the LinkedIn app's share sheet actually produces.
check("the share-sheet shape", linkedInActivityId("https://www.linkedin.com/posts/vikashsharmavsrv_basics-of-email-writing-beginners-activity-7131590082221752320-9C4_"), "7131590082221752320");
check("with tracking on the end", linkedInActivityId("https://www.linkedin.com/posts/x_y-activity-7131590082221752320-9C4_?utm_source=share"), "7131590082221752320");
check("the feed-update form", linkedInActivityId("https://www.linkedin.com/feed/update/urn:li:activity:7131590082221752320"), "7131590082221752320");
check("a ugcPost urn", linkedInActivityId("https://www.linkedin.com/feed/update/urn:li:ugcPost:7131590082221752320"), "7131590082221752320");
// A job link has its own id and its own endpoint; it must not be read as a post.
check("a job link has no activity id", linkedInActivityId("https://www.linkedin.com/jobs/view/4287321907"), null);
check("a profile has none either", linkedInActivityId("https://www.linkedin.com/in/someone"), null);

section("which LinkedIn links are worth fetching");
check("a job", isReadableLinkedIn("https://www.linkedin.com/jobs/view/4287321907"), true);
check("a post", isReadableLinkedIn("https://www.linkedin.com/posts/x_y-activity-7131590082221752320-9C4_"), true);
check("a short link, which could be either", isReadableLinkedIn("https://lnkd.in/dKfPmGXw"), true);
check("a profile", isReadableLinkedIn("https://www.linkedin.com/in/someone"), false);
check("a company page", isReadableLinkedIn("https://www.linkedin.com/company/acme"), false);

section("reading an embedded feed post");
// The embed names no author anywhere; og:title is the only place it appears.
const embed = `
  <meta property="og:title" content="We are hiring | Priya Nair | 12 comments" />
  <p class="attributed-text-segment-list__content">We are hiring a React developer in Noida.<br>Send your CV to hr@acme.in</p>`;
const post = parseEmbeddedPost(embed, "7131590082221752320", "https://www.linkedin.com/posts/x");
check("the author comes out of og:title", post.author, "Priya Nair");
check("the post text", post.text, "We are hiring a React developer in Noida.\nSend your CV to hr@acme.in");
check("and the address to write to", post.emails, ["hr@acme.in"]);
// Some posts read "Aya Waled posted on the topic of hiring".
check("a wordy og:title still gives a name", parseEmbeddedPost('<meta property="og:title" content="x | Aya Waled posted on the topic | 3 comments" /><p class="attributed-text-segment-list__content">hi</p>', "1", "u").author, "Aya Waled");
check("a post with no text at all reads as nothing", parseEmbeddedPost('<meta property="og:title" content="a | b | c" />', "1", "u"), null);

section("the author, from either page's og:title");
// The embed adds a comment count; the ordinary page does not. Dropping the
// count first makes the author the last part in both cases.
check("the embed shape", authorFromOgTitle("We are hiring | Priya Nair | 12 comments"), "Priya Nair");
check("the ordinary page shape", authorFromOgTitle("We are hiring at Kolte | Girish Kolte"), "Girish Kolte");
check("likes are dropped too", authorFromOgTitle("x | Girish Kolte | 40 likes"), "Girish Kolte");
check("a wordy one keeps just the name", authorFromOgTitle("x | Aya Waled posted on the topic | 3 comments"), "Aya Waled");
check("nothing to split gives nothing", authorFromOgTitle("Just a title"), "");
check("empty gives nothing", authorFromOgTitle(""), "");

section("falling back to the ordinary page when the embed will not render");
// Verified against a real post: og:description carries the whole thing,
// address included, even where the embed returns nothing usable.
const ogPage = `
  <meta property="og:title" content="We are hiring at KolteTechnologies | Girish Kolte" />
  <meta property="og:description" content="We are hiring at KolteTechnologies. Share your resume at hr.kolte@gmail.com" />`;
const fallback = parseOgPost(ogPage, "7488461877862330369", "https://www.linkedin.com/posts/x");
check("the text comes from og:description", fallback.text.includes("Share your resume"), true);
check("the author still comes out", fallback.author, "Girish Kolte");
check("and so does the address", fallback.emails, ["hr.kolte@gmail.com"]);
check("a page with no description reads as nothing", parseOgPost('<meta property="og:title" content="a | b" />', "1", "u"), null);

section("the og tag reader");
check("finds a property", ogTag('<meta property="og:title" content="Hello" />', "og:title"), "Hello");
check("decodes entities", ogTag('<meta property="og:title" content="R&amp;D" />', "og:title"), "R&D");
check("missing is empty", ogTag("<html></html>", "og:title"), "");

section("a post handed to the reader");
check("it says who posted it", postAsText(post).startsWith("Posted by Priya Nair on LinkedIn"), true);
check("and carries the post itself", postAsText(post).includes("Send your CV to hr@acme.in"), true);

section("shortened links have to be followed first");
check("lnkd.in", isShortLink("https://lnkd.in/dKfPmGXw"), true);
check("a full job url is not short", isShortLink("https://www.linkedin.com/jobs/view/4287321907"), false);

section("turning LinkedIn's markup into text");
check("breaks become newlines", toPlainText("one<br>two"), "one\ntwo");
check("list items get a bullet", toPlainText("<ul><li>one</li><li>two</li></ul>"), "• one\n• two");
check("entities are decoded", toPlainText("R&amp;D &lt;tag&gt; &quot;x&quot;"), 'R&D <tag> "x"');
check("numeric entities too", toPlainText("caf&#233;"), "café");
check("runs of blank lines collapse", toPlainText("<p>a</p><p></p><p></p><p>b</p>"), "a\n\nb");
check("nothing is nothing", toPlainText(""), "");

section("finding an element by class, with nesting respected");
const nested = '<div class="markup">outer <div class="inner">middle</div> tail</div><div>after</div>';
check("the matching close tag is found", extractByClass(nested, "markup"), 'outer <div class="inner">middle</div> tail');
check("a missing class gives nothing", extractByClass(nested, "absent"), null);

section("reading a whole guest response");
// Shaped like the real thing: three "flavor" spans, only one a location.
const page = `
  <h2 class="topcard__title">Frontend Developer (React Js)</h2>
  <a class="topcard__org-name-link">DecodeUp (P) Limited</a>
  <span class="topcard__flavor">DecodeUp (P) Limited</span>
  <span class="topcard__flavor topcard__flavor--bullet">Chorasi, Gujarat, India</span>
  <span class="posted-time-ago__text topcard__flavor--metadata">1 year ago</span>
  <div class="show-more-less-html__markup">
    <p>We need a React developer.</p><p>Write to hr@decodeup.com or connect@decodeup.com</p>
    <p>Do not contact jobs@linkedin.com</p>
  </div>`;
const job = parseGuestJob(page, "4287321907", "https://www.linkedin.com/jobs/view/4287321907");
check("the title", job.title, "Frontend Developer (React Js)");
check("the company", job.company, "DecodeUp (P) Limited");
// The date also wears a "flavor" class; taking the last span said "1 year ago".
check("the location, not the date", job.location, "Chorasi, Gujarat, India");
check("the description came through", job.description.includes("React developer"), true);
check("both employer addresses", job.emails, ["hr@decodeup.com", "connect@decodeup.com"]);
check("LinkedIn's own address is not the employer's", job.emails.includes("jobs@linkedin.com"), false);
check("an empty page reads as nothing", parseGuestJob("<div></div>", "1", "u"), null);

section("what gets handed to the reader");
const posting = asPostingText(job);
check("it leads with the role", posting.startsWith("Frontend Developer (React Js)"), true);
check("it names the company", posting.includes("Company: DecodeUp (P) Limited"), true);
check("it names the place", posting.includes("Location: Chorasi, Gujarat, India"), true);
check("and the contact is spelled out", posting.includes("Contact: hr@decodeup.com"), true);

section("a shared LinkedIn job is routed differently from other links");
check("a job link", classifyShare("https://www.linkedin.com/jobs/view/4287321907").kind, "linkedin");
check("the url is carried through", classifyShare("https://www.linkedin.com/jobs/view/4287321907").url, "https://www.linkedin.com/jobs/view/4287321907");
check("a job link with a title beside it", classifyShare("Frontend Developer", "https://in.linkedin.com/jobs/view/4287321907").kind, "linkedin");
check("a feed post is readable too", classifyShare("https://www.linkedin.com/posts/x_activity-7123456789012345678").kind, "linkedin");
check("some other link too", classifyShare("https://example.com/j/1").kind, "link-only");
check("real pasted text is unaffected", classifyShare("We are hiring a frontend developer in Noida with two years of React experience today").kind, "usable");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
