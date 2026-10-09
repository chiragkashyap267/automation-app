# JD Mailer Autofill

Fills job application forms from the profile you already keep in the app, and
attaches your resume. Nothing is ever submitted for you.

## Installing it

1. Open `chrome://extensions` in Chrome or Edge.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension` folder.
4. Click the extension's **Details → Extension options**, enter your app
   password (the same one the web app asks for), and save.

## Using it

Open an application form, click the extension icon, then **Fill this form**.
A panel appears on the page with what it filled, what it left alone and why.

### It works on forms nobody wrote rules for

A label the pattern list cannot place is sent to the app, which asks a model
what the field is asking for. Only the label goes -- never your name, your
phone number or your resume. The profile stays in the browser.

### It stops being wrong

The panel lists anything it did not recognise with a picker beside it. Name a
field once and it is remembered, against this site and in general, and from
then on it beats both the pattern list and the model.

It also learns on its own: type your phone number by hand into a field it
missed, and it works out that the label meant phone. Only exact matches
count -- a half-match would teach it something wrong, and a wrong lesson is
worse than none because it then outranks everything else.

### Cover letters

When a form has a cover-letter box, one is written from your resume and that
posting, and typed in. Never a stock paragraph: if no letter has been written
for this application, the box is left empty.

### Options worth knowing

- **Fill automatically when a form opens** -- off by default.
- **Write a cover letter when the form asks for one** -- on.
- **Keep filling as a multi-page form moves on** -- on. Workday and the
  portals built like it swap fields out without changing the address, so one
  fill only covers the first step.

If a field is still missed, use **What can you see on this page?**. It lists
every field with the words it read and the kind it decided on.

## What it will not do

- **Submit anything.** It fills and stops.
- **Tick a box.** Consent, sponsorship and eligibility are yours to answer.
- **Guess money or dates.** Current salary, expected salary and notice period
  are left blank on purpose — a wrong number cannot be un-said.
- **Overwrite you.** A field you have already typed in is left as it is.

## Company portals: TCS, Infosys, HCL and the rest

These are loaded automatically now, along with the platforms most Indian
employers sit on — SuccessFactors, Phenom, Taleo, iCIMS, Oracle, PeopleStrong,
Darwinbox, Keka, Zoho Recruit, Zwayam.

They all ask for the same long list, so it is typed once in the options:
date of birth, 10th and 12th marks, boards and passing years, degree, branch,
college, graduation marks and year, current employer and designation.

**What it cannot do, and will not pretend to:**

- **Register or log in for you.** Every one of these portals wants an account
  before it shows you a form. It can fill the signup fields it recognises, but
  an OTP, an email verification or a captcha is yours.
- **Fill a table.** TCS and Infosys often lay education out as a grid, with one
  row per qualification and the labels as column headings. Every row then reads
  as "Percentage" with nothing to say which qualification it belongs to, so
  those cells are left alone rather than filled with a guess. Use **What can
  you see on this page?** — if the rows turn out to be distinguishable, the rule
  is a small fix.
- **Carry you through a wizard.** These forms run over several pages. Press
  Fill on each one.

**What it refuses outright:** PAN, Aadhaar, passport number, bank account,
IFSC, UAN or PF number, passwords and captchas. A government number filled in
wrongly can invalidate an application, and none of it belongs in a browser
extension's storage.

## Where it works

The known boards — Greenhouse, Lever, Ashby, SmartRecruiters, Workday and
HCLTech — load it automatically. On a company's own careers site, the button
injects it on demand, so it still works without asking for permission to read
every site you visit.

Matching is on the words next to each box, not on a list of selectors per
employer, so an unseen form usually works first time.

## Why there is no mobile version

Chrome on Android does not support extensions at all. Filling forms inside
native apps would need an Android Accessibility Service, which can read and
act on every screen on the phone — far too much power for this, and the kind
of permission that gets an app removed.

## How your details get here

The extension asks the app for the profile over HTTPS and holds the password
in this browser's extension storage only. The page you are applying on never
sees the password: the request is made by the background service worker, not
by the script running inside the careers site.

Your Gmail password is never part of this. The app strips credentials before
storing the shared profile, so there is nothing of that kind to send.
