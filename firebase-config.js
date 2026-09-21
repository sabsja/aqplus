import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCpkKn0OpV7IvBwMKpU9e2JF1HBfO2NH88",
  authDomain: "aqplus-58313.firebaseapp.com",
  projectId: "aqplus-58313",
  storageBucket: "aqplus-58313.firebasestorage.app",
  messagingSenderId: "734759124100",
  appId: "1:734759124100:web:df0f98f23f012c8fd496d1"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);