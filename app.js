// Connect to backend Socket.IO (replace with your actual backend URL)
const socket = io("https://lt-119.onrender.com");

const usernameInput = document.getElementById('username');
const channelSelect = document.getElementById('channel');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const pttBtn = document.getElementById('pttBtn');
const usersDiv = document.getElementById('users');
const muteBtn = document.getElementById('muteBtn');
const statusDiv = document.getElementById('status');

let currentChannel = null;
let username = null;

// WebRTC state
let localStream = null;
let micTrack = null;               // local audio track for PTT enable/disable
let peerConnections = {};          // { peerId: RTCPeerConnection }
let remoteAudios = {};             // { peerId: HTMLAudioElement }
let muted = false;                 // global mute state

// Sound effects (relative to root)
const beepOn = new Audio('assets/sound/beep-on.mp3');
const beepOff = new Audio('assets/sound/beep-off.mp3');
const staticSound = new Audio('assets/sound/static.mp3');
staticSound.loop = true;        // make it loop continuously
staticSound.volume = 0.75;      // set volume to 75% instead of 100%

// Status helper
function showStatus(message, isError = true) {
  statusDiv.className = 'status ' + (isError ? 'error' : 'success');
  statusDiv.textContent = message;
}

// Helper: is the user currently typing in a field?
function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  const editable = el.isContentEditable;
  return (editable || tag === 'INPUT' || tag === 'TEXTAREA');
}

// Restore saved settings
window.addEventListener('DOMContentLoaded', () => {
  const savedName = localStorage.getItem('username');
  const savedChannel = localStorage.getItem('channel');
  if (savedName) usernameInput.value = savedName;
  if (savedChannel) channelSelect.value = savedChannel;
});

// Join channel
joinBtn.addEventListener('click', async () => {
  const channel = channelSelect.value;
  if (!channel) {
    showStatus('Please select a channel before joining.');
    return;
  }
  if (currentChannel === channel) {
    showStatus(`Already connected to Channel ${channel}`, true);
    return;
  }
  username = usernameInput.value.replace(/\s+/g, ' ').trim();
  if (!username) {
    username = `User-${Math.floor(Math.random() * 1000)}`;
  }
  localStorage.setItem('username', username);
  localStorage.setItem('channel', channel);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    micTrack = localStream.getAudioTracks()[0];
    if (micTrack) micTrack.enabled = false;
    socket.emit('joinChannel', { channel, username });
    showStatus(`Joining Channel ${channel} as ${username}...`, false);
    joinBtn.blur();
  } catch (err) {
    console.error('Microphone error:', err);
    showStatus('Microphone access denied or unavailable.');
  }
});

// Leave channel
leaveBtn.addEventListener('click', () => {
  if (!currentChannel) {
    showStatus('You are not connected to any channel.', true);
    return;
  }
  socket.emit('leaveChannel', { channel: currentChannel, username });
  leaveBtn.blur();
  Object.values(peerConnections).forEach(pc => { try { pc.close(); } catch {} });
  peerConnections = {};
  Object.values(remoteAudios).forEach(audio => {
    try { audio.pause(); } catch {}
    if (audio.parentNode) audio.parentNode.removeChild(audio);
  });
  remoteAudios = {};
  if (micTrack) micTrack.enabled = false;
});

// PTT press (mouse)
pttBtn.addEventListener('mousedown', () => {
  if (!currentChannel) {
    showStatus('You must join a channel before talking.');
    return;
  }
  startTalking();
});

// PTT release (mouse)
pttBtn.addEventListener('mouseup', () => {
  if (!currentChannel) return;
  stopTalking();
});

// Spacebar PTT support
let spacePressed = false;

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !spacePressed) {
    if (isTyping()) return;
    e.preventDefault(); // prevent scrolling
    spacePressed = true;
    if (!currentChannel) {
      showStatus('You must join a channel before talking.');
      return;
    }
    startTalking();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spacePressed) {
    if (isTyping()) {
      spacePressed = false;
      return;
    }
    e.preventDefault(); // prevent scrolling
    spacePressed = false;
    if (!currentChannel) return;
    stopTalking();
  }
});

// Talking helpers (PTT via track enable/disable)
function startTalking() {
  pttBtn.classList.add('active');
  try { beepOn.play(); } catch {}
  if (micTrack) micTrack.enabled = true;

  // Play static locally until actual audio is detected
  try { staticSound.play(); } catch {}

  // Immediately update *your own* talking indicator locally
  const userEl = document.getElementById(`user-${socket.id}`);
  if (userEl) {
    userEl.classList.add('talking');
    userEl.innerHTML = `<b>${username}</b> (talking)`;
  }

  socket.emit('startTalking', currentChannel);
}

function stopTalking() {
  pttBtn.classList.remove('active');
  setTimeout(() => { try { beepOff.play(); } catch {} }, 200);
  if (micTrack) micTrack.enabled = false;

  // Stop static when you stop talking
  try { staticSound.pause(); staticSound.currentTime = 0; } catch {}

  const userEl = document.getElementById(`user-${socket.id}`);
  if (userEl) {
    userEl.classList.remove('talking');
    userEl.innerHTML = `<b>${username}</b>`;
  }

  socket.emit('stopTalking', currentChannel);
}

// Disconnect on unload
window.addEventListener('beforeunload', () => {
  socket.disconnect();
  Object.values(peerConnections).forEach(pc => { try { pc.close(); } catch {} });
});

// Active channel awareness
socket.on('activeChannel', (channel) => {
  currentChannel = channel;
  if (channel) {
    showStatus(`Active Channel: ${channel}`, false);
  } else {
    showStatus('Left channel. Select a channel to join.', false);
    channelSelect.value = '';
    usersDiv.innerHTML = '';
  }
});

// User list rendering
socket.on('userList', (users) => {
  if (!currentChannel) {
    usersDiv.innerHTML = '';
    return;
  }
  usersDiv.innerHTML = `<h3>Active Channel: ${currentChannel}</h3><h4>Users:</h4>`;
  users.forEach(user => {
    const userEl = document.createElement('div');
    userEl.id = `user-${user.id}`;
    userEl.innerHTML = `<b>${user.username}</b>`;
    usersDiv.appendChild(userEl);
  });
});

// Speaking indicators (UI only)
socket.on('userTalking', (data) => {
  const userEl = document.getElementById(`user-${data.id}`);
  if (userEl) {
    if (data.talking) {
      userEl.classList.add('talking');
      userEl.innerHTML = `<b>${data.username}</b> (talking)`;
      // Stop static if someone else is talking
      if (data.id !== socket.id) {
        try { staticSound.pause(); staticSound.currentTime = 0; } catch {}
      }
    } else {
      userEl.classList.remove('talking');
      userEl.innerHTML = `<b>${data.username}</b>`;
    }
  }
});

// Peer presence events
socket.on('peerJoined', ({ id, username }) => {
  const pc = createPeerConnection(id);
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
  pc._peerId = id;

  pc.createOffer()
    .then(offer => pc.setLocalDescription(offer))
    .then(() => {
      socket.emit('offer', { channel: currentChannel, offer: pc.localDescription, to: id });
    })
    .catch(err => console.error('Offer error:', err));
});

socket.on('peerLeft', ({ id }) => {
  const pc = peerConnections[id];
  if (pc) {
    try { pc.close(); } catch {}
    delete peerConnections[id];
  }
  const audio = remoteAudios[id];
  if (audio) {
    try { audio.pause(); } catch {}
    if (audio.parentNode) audio.parentNode.removeChild(audio);
    delete remoteAudios[id];
  }
});

// WebRTC signaling handlers
socket.on('offer', async ({ id, offer }) => {
  let pc = peerConnections[id];
  if (!pc) {
    pc = createPeerConnection(id);
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    pc._peerId = id;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { channel: currentChannel, answer: pc.localDescription, to: id });
  } catch (err) {
    console.error('Answer error:', err);
  }
});

socket.on('answer', async ({ id, answer }) => {
  const pc = peerConnections[id];
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    console.error('Set remote answer error:', err);
  }
});

socket.on('iceCandidate', async ({ id, candidate }) => {
  const pc = peerConnections[id];
  if (!pc || !candidate) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('Add ICE candidate error:', err);
  }
});

// Create and maintain a peer connection to a specific peer
function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
  });

  peerConnections[peerId] = pc;

  pc.ontrack = (event) => {
    let audio = remoteAudios[peerId];
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.playsInline = true;
      remoteAudios[peerId] = audio;
      document.body.appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    audio.muted = muted; // apply global mute state
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('iceCandidate', { channel: currentChannel, candidate: event.candidate, to: peerId });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      const audio = remoteAudios[peerId];
      if (audio) {
        try { audio.pause(); } catch {}
        if (audio.parentNode) audio.parentNode.removeChild(audio);
        delete remoteAudios[peerId];
      }
      delete peerConnections[peerId];
    }
  };

  return pc;
}

// Mute button control (apply to all remote audio elements)
muteBtn.addEventListener('click', () => {
  muted = !muted;
  muteBtn.textContent = muted ? 'Unmute' : 'Mute';
  Object.values(remoteAudios).forEach(a => { a.muted = muted; });
});