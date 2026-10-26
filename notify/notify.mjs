import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

// Initialize Firebase Admin using GitHub secret
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

initializeApp({
  credential: cert(serviceAccount)
});

console.log("Firebase Admin initialized for notification runner.");
