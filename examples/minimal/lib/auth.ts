import { firestoreAdapter } from "@yultyyev/better-auth-firestore";
import { betterAuth } from "better-auth";
import admin from "firebase-admin";

const firebaseAdminCredentials = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY,
};
// Or use the service account path
// const firebaseAdminCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  
admin.initializeApp({
  credential: admin.credential.cert(firebaseAdminCredentials),
  projectId: process.env.FIREBASE_PROJECT_ID,
});

const db = admin.firestore();

export const auth = betterAuth({
  database: firestoreAdapter(db),
  emailAndPassword: {
    enabled: true,
  },
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: "/api/auth",
  secret: process.env.BETTER_AUTH_SECRET,
});

