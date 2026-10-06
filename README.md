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

## Development

Install dependencies with `pnpm install`, then run `pnpm dev`. Without a configured remote database, local development uses the existing SQLite fallback.
