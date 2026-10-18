# Quiz Checker

## MongoDB

The app stores saved exams in the `exams` collection. It creates the collection and a unique index automatically on first use.

Set these environment variables in `.env.local` for local development and in **Vercel Project Settings > Environment Variables** for deployed environments:

```env
MONGODB_URI="mongodb+srv://<username>:<password>@<cluster-host>/quiz_checker?retryWrites=true&w=majority"
MONGODB_DATABASE="quiz_checker"
```

Use the connection URI supplied by your MongoDB provider. If the URI already names the database, `MONGODB_DATABASE` is optional. Keep the credentials server-only; do not use a `NEXT_PUBLIC_` prefix. Select Production and any other Vercel environments you deploy, then redeploy after changing variables.

The MongoDB server must allow connections from Vercel. Configure Atlas Network Access for your deployment's supported egress IPs or private connection. Avoid opening database access to the entire internet when a narrower option is available.

MongoDB variables take precedence over the legacy MySQL (`MYSQL_URL`) and Neon/Postgres (`DATABASE_URL`) settings. Existing records in another database are not copied automatically; this app will read and write records in MongoDB after switching.

## Answer-sheet recognition

The answer checker offers two image-reading options:

```env
GOOGLE_CLOUD_VISION_API_KEY="your-server-side-api-key"
GEMINI_API_KEY="your-server-side-api-key"
```

- **Read answer sheet and OCR** uses Google Cloud Vision to locate printed item numbers and recognize isolated answer rows. If Vision is unavailable, it falls back to local Tesseract OCR.
- **Transcribe answers visually with Gemini** sends the original image and the selected page's item numbers to Gemini 2.5 Flash. Gemini inspects the image visually and returns answers by item number; it does not grade them.

Set the relevant API key only as a server-side environment variable in `.env.local` and your deployment settings. Do not use a `NEXT_PUBLIC_` prefix. The visual-transcription option requires `GEMINI_API_KEY`; the OCR option requires `GOOGLE_CLOUD_VISION_API_KEY` for cloud OCR. Uploaded images are sent to the selected Google service. Usage may incur charges and is subject to provider quotas and data policies. Review every answer before grading; uncertain handwriting may still be misread.

## Development

Install dependencies with `pnpm install`, then run `pnpm dev`. Without a configured remote database, local development uses the existing SQLite fallback.
