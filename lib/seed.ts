import type { Profile } from "./types";

/**
 * Starting profile, used only when nothing has been saved in this browser yet.
 * Anything edited in Details overwrites it and persists from then on.
 *
 * Drawn from chiragkashyapwebdev.vercel.app. Gmail credentials are deliberately
 * left blank — an App Password does not belong in source control.
 */
export const SEED_PROFILE: Partial<Profile> = {
  fullName: "Chirag Kashyap",
  email: "chiragkashyap26712@gmail.com",
  phone: "+91 95481 74325",
  location: "Noida, Uttar Pradesh, India",
  headline: "Full Stack Web & Mobile Developer",
  yearsExperience: "2",
  linkedin: "linkedin.com/in/chiragkashyap267",
  github: "github.com/chiragkashyap267",
  portfolio: "chiragkashyapwebdev.vercel.app",
  skills:
    "React.js, Next.js, React Native, Node.js, Express.js, JavaScript, Java, SQL, MySQL, Firebase, Tailwind CSS, Bootstrap, REST APIs, Razorpay, WordPress, Shopify, Git, Vercel, Netlify",
  tone: "warm",
  signOff: "Best regards",
  extraNotes: "Open to full-time roles. Comfortable with both web and mobile (React Native) work.",
  resumeText: `Chirag Kashyap — Full Stack Web & Mobile Developer
Noida, Uttar Pradesh, India | chiragkashyap26712@gmail.com | +91 95481 74325
linkedin.com/in/chiragkashyap267 | github.com/chiragkashyap267 | chiragkashyapwebdev.vercel.app

SUMMARY
Full-stack developer with 2+ years of experience building fast, scalable web and mobile products.
Works across React.js, Next.js and React Native, with Node.js and Express on the backend.

EXPERIENCE

Associate Software Engineer — Labhyansh (Jun 2026 – Present)
- Builds cross-platform iOS and Android applications in React Native.
- Develops web products in Next.js and React.js.
- Ships AI-integrated features into production.

Web Developer Intern — Growthpandit Pvt. Ltd. (Jan 2026 – Jun 2026)
- Built and deployed 4+ full-stack web applications.
- Delivered 20+ WordPress and Shopify solutions for clients.
- Achieved PageSpeed scores above 90 on delivered sites.
- Cut project delivery time by 30% by streamlining the build process.

Web Developer Intern — Elem Consumer Tech Pvt. Ltd. (Jan 2023 – Jul 2024)
- Developed and customised Shopify storefronts.
- Improved engagement and conversion rates by 20%.
- Built responsive interfaces in React.js.

PROJECTS

Mockly AI — AI mock interview platform.
Next.js with voice-to-voice AI, deployed on Vercel. Runs practice interviews and gives feedback.

Vayu-WARN — Real-time disaster alert system.
Next.js, Firebase and Leaflet. Shows live alerts on a map, deployed on Vercel.

CampusVault — Academic resource hub.
Next.js, Firebase and Tailwind CSS. Central place for students to find and share course material.

EDUCATION
MCA — GB Pant Engineering College (Jun 2024 – Jun 2026), CGPA 9.1
B.Sc. Computer Science — KL DAV PG College (2021 – 2024), CGPA 6.5

SKILLS
Languages: JavaScript, Java, SQL
Frontend: React.js, Next.js, React Native, Tailwind CSS, Bootstrap
Backend: Node.js, Express.js, REST APIs
Data: MySQL, Firebase
Platforms: WordPress, Shopify, Razorpay integration
Tooling: Git, Vercel, Netlify, AI-assisted development`,
};
