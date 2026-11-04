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

// Keep every message in IndexedDB so the app can show it in full (same database the page reads).
function inboxAdd(item){
  return new Promise(res=>{
    const r=indexedDB.open('igm-inbox',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('msgs',{keyPath:'id'});
    r.onsuccess=()=>{const tx=r.result.transaction('msgs','readwrite');tx.objectStore('msgs').put(item);tx.oncomplete=()=>res();tx.onerror=()=>res();};
    r.onerror=()=>res();
  });
}
// Messages are data-only; we store and show them ourselves so there are never duplicates.
messaging.onBackgroundMessage(p=>{
  const d=p.data||{};
  const id=Date.now()+'-'+Math.random().toString(36).slice(2,7);
  const title=d.title||'My Portfolio',body=d.body||'';
  return inboxAdd({id,title,body,ts:Date.now(),read:false})
    .then(()=>self.registration.showNotification(title,{
      body,tag:id,icon:'icon.svg',badge:'icon.svg',data:{url:d.url||'./'}
    }))
    .then(()=>clients.matchAll({type:'window',includeUncontrolled:true}))
    .then(list=>list.forEach(c=>c.postMessage({type:'inbox-updated'})));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  let url=(e.notification.data&&e.notification.data.url)||'./';
  if(url.indexOf('#')<0)url+='#inbox';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    for(const c of list){
      if('focus' in c){c.postMessage({type:'open-inbox'});return c.focus();}
    }
    return clients.openWindow(url);
  }));
});

self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(clients.claim()));
