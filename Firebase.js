// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAdKShZMYYdmZ3bkmaDWsEhsLsT0YIgz-8",
  authDomain: "dontrading-pro.firebaseapp.com",
  projectId: "dontrading-pro",
  storageBucket: "dontrading-pro.firebasestorage.app",
  messagingSenderId: "684854856085",
  appId: "1:684854856085:web:fd18dc2c46ff13ea81ce9c",
  measurementId: "G-FYNX14F2VY"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);