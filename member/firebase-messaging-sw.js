importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey:"AIzaSyAmWOFu5I7yyMy7clIM-LHt9cxa8RfDBt4",
  authDomain:"investgroup-5f2f9.firebaseapp.com",
  databaseURL:"https://investgroup-5f2f9-default-rtdb.firebaseio.com",
  projectId:"investgroup-5f2f9",
  storageBucket:"investgroup-5f2f9.firebasestorage.app",
  messagingSenderId:"422666447690",
  appId:"1:422666447690:web:d800f06e8a8b9fe0d32fb3"
});
const messaging=firebase.messaging();
// Messages are data-only; we show them ourselves so there are never duplicates.
messaging.onBackgroundMessage(p=>{
  const d=p.data||{};
  return self.registration.showNotification(d.title||'My Portfolio',{
    body:d.body||'',tag:d.tag||undefined,icon:'icon.svg',badge:'icon.svg',data:{url:d.url||'./'}
  });
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'./';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){if('focus' in c)return c.focus();}
    return clients.openWindow(url);
  }));
});
