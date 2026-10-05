# Quiz Checker

## Local MySQL with XAMPP

1. Start **MySQL** from the XAMPP Control Panel.
2. Open phpMyAdmin at `http://localhost/phpmyadmin` and import `database/schema.mysql.sql`.
3. Copy `.env.example` to `.env.local`. For a default XAMPP installation, use:

   ```env
   MYSQL_URL="mysql://root@127.0.0.1:3306/quiz_checker"
   ```

   If you set a MySQL root password, include it in the URL and URL-encode special characters.
4. Install dependencies with `pnpm install`, then run `pnpm dev`.

The app also creates the `exams` table automatically when it first connects. The SQL file creates the database and the same table in advance.

## Vercel

XAMPP runs on your own computer, so a Vercel deployment cannot connect to that local MySQL server. Set `MYSQL_URL` in Vercel to a hosted MySQL database that accepts connections from Vercel, and create the `quiz_checker` database there. Do not expose your local XAMPP server to the public internet. An existing Neon Postgres connection can still be supplied as `DATABASE_URL` if preferred.

Database URLs are server-only environment variables; do not prefix them with `NEXT_PUBLIC_` or commit real credentials.
