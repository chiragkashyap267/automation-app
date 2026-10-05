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
It reports what it filled, what it left alone and why, and anything it did not
recognise.

If a field is missed, use **What can you see on this page?**. It lists every
field with the words it read and the kind it decided on, which is enough to
say what the rule should be.

## What it will not do

- **Submit anything.** It fills and stops.
- **Tick a box.** Consent, sponsorship and eligibility are yours to answer.
- **Guess money or dates.** Current salary, expected salary and notice period
  are left blank on purpose — a wrong number cannot be un-said.
- **Overwrite you.** A field you have already typed in is left as it is.

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
