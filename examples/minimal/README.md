# Better Auth Firestore - Minimal Example

This is a minimal example setup demonstrating how to use [`better-auth-firestore`](https://github.com/yultyyev/better-auth-firestore) with [better-auth](https://www.better-auth.com/) in a Next.js application.

This example showcases:
- Email/password authentication with better-auth
- Google Firestore Database as the database adapter
- Next.js App Router integration
- Client-side authentication hooks
- Protected routes

## Prerequisites

- Node.js 20 or higher (Node.js 24 LTS recommended)
- A Firebase project with Google Firestore Database enabled
- Firebase Admin SDK credentials (service account key)

## Setup

1. **Install dependencies:**

```bash
npm install
# or
pnpm install
# or
yarn install
```

2. **Configure environment variables:**

Copy `.env.example` to `.env` and fill in your Firebase credentials:

```bash
cp .env.example .env
```

Edit `.env` with your values:
- `BETTER_AUTH_SECRET`: Generate with `openssl rand -base64 32`
- `BETTER_AUTH_URL`: Your application URL (e.g., `http://localhost:3000`)
- `FIREBASE_PROJECT_ID`: Your Firebase project ID
- `FIREBASE_CLIENT_EMAIL`: Service account email
- `FIREBASE_PRIVATE_KEY`: Service account private key

Alternatively, you can use a service account JSON file:
- Set `FIREBASE_SERVICE_ACCOUNT_PATH` to the path of your service account JSON file

3. **Run the development server:**

```bash
npm run dev
# or
pnpm dev
# or
yarn dev
```

Open [http://localhost:3000](http://localhost:3000) to see the example.

## Project Structure

- `lib/auth.ts` - better-auth configuration with Google Firestore adapter
- `app/api/auth/[...all]/route.ts` - Authentication API route handler
- `components/auth-client.ts` - Client-side auth utilities
- `components/login-form.tsx` - Login form component
- `components/register-form.tsx` - Registration form component
- `app/(auth)/protected/page.tsx` - Example protected route

## Learn More

- [better-auth Documentation](https://www.better-auth.com/docs)
- [better-auth-firestore](https://github.com/yultyyev/better-auth-firestore)
- [Next.js Documentation](https://nextjs.org/docs)
