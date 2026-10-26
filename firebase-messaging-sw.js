importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "BGZUPMUwpdj45XQ9GUaGZj3F6n2rZUVMXhFS41jeFjZFvzwZmt_BNxkDc6mQ_4fSHlnI4ZFW0HnkQOiAQDwR49Q",
  projectId: "investgroup-5f2f9",
  messagingSenderId: "422666447690",
  appId: "1:422666447690:web:d800f06e8a8b9fe0d32fb3"
});

const messaging = firebase.messaging();
