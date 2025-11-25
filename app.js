// Connect to backend Socket.IO (replace with your actual backend URL)
const socket = io("https://lt-119.onrender.com");

const usernameInput = document.getElementById('username');
const channelSelect = document.getElementById('channel');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const pttBtn = document.getElementById('pttBtn');
const usersDiv = document.getElementById('users');
const volumeSlider = document.getElementById('volume');
const muteBtn = document.getElementById('muteBtn');
const statusDiv = document.getElementById('status');

let currentChannel = null;
let mediaRecorder = null;
let audioStream = null;
let username = null;

// Playback setup
let mediaSource = new MediaSource();
let sourceBuffer;
let audioElement = new Audio();
audioElement.src = URL.createObjectURL(mediaSource);
audioElement.autoplay = true;

mediaSource.addEventListener('sourceopen', () => {
  sourceBuffer = mediaSource.addSourceBuffer('audio/webm; codecs=opus');
});

// Sound effects (relative to root)
const beepOn = new Audio('assets/sound/beep-on.mp3');
const beepOff = new Audio('assets/sound/beep-off.mp3');

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
joinBtn.addEventListener('click', () => {
  const channel = channelSelect.value;
  if (!channel) {
    showStatus('Please select a channel before joining.');
    return;
  }

  if (currentChannel === channel) {
    showStatus(`Already connected to Channel ${channel}`, true);
    return;
  }

  // Allow spaces inside the username; collapse multiples
  username = usernameInput.value.replace(/\s+/g, ' ').trim();
  if (!username) {
    username = `User-${Math.floor(Math.random() * 1000)}`;
  }

  localStorage.setItem('username', username);
  localStorage.setItem('channel', channel);

  socket.emit('joinChannel', { channel, username });
  showStatus(`Joining Channel ${channel} as ${username}...`, false);

  // Remove focus so spacebar won't "click" this button later
  joinBtn.blur();
});

// Leave channel
leaveBtn.addEventListener('click', () => {
  if (!currentChannel) {
    showStatus('You are not connected to any channel.', true);
    return;
  }
  socket.emit('leaveChannel', { channel: currentChannel, username });
  leaveBtn.blur();
});

// PTT press (mouse)
pttBtn.addEventListener('mousedown', async () => {
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

document.addEventListener('keydown', async (e) => {
  if (e.code === 'Space' && !spacePressed) {
    if (isTyping()) return; // allow typing spaces
    e.preventDefault(); // prevent button clicks
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
    e.preventDefault();
    spacePressed = false;

    if (!currentChannel) return;
    stopTalking();
  }
});

// Talking helpers
async function startTalking() {
  pttBtn.classList.add('active');
  beepOn.play();

  try {
    if (!audioStream) {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    mediaRecorder = new MediaRecorder(audioStream);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        socket.emit('audioChunk', {
          channel: currentChannel,
          chunk: event.data
        });
      }
    };

    mediaRecorder.start(250);
    socket.emit('startTalking', currentChannel);
  } catch (err) {
    showStatus('Microphone access denied or unavailable.');
    console.error('Microphone error:', err);
  }
}

function stopTalking() {
  pttBtn.classList.remove('active');
  setTimeout(() => beepOff.play(), 200);

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }

  socket.emit('stopTalking', currentChannel);
}

// Disconnect on unload
window.addEventListener('beforeunload', () => {
  socket.disconnect();
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

// Speaking indicators
socket.on('userTalking', (data) => {
  const userEl = document.getElementById(`user-${data.id}`);
  if (userEl) {
    if (data.talking) {
      userEl.classList.add('talking');
      userEl.innerHTML = `<b>${data.username}</b> (talking)`;
    } else {
      userEl.classList.remove('talking');
      userEl.innerHTML = `<b>${data.username}</b>`;
    }
  }
});

// Receive audio
socket.on('audioChunk', (data) => {
  const reader = new FileReader();
  reader.onload = () => {
    if (sourceBuffer && !sourceBuffer.updating) {
      sourceBuffer.appendBuffer(new Uint8Array(reader.result));
    }
  };
  reader.readAsArrayBuffer(data.chunk);
});

// Volume/mute controls
volumeSlider.addEventListener('input', () => {
  audioElement.volume = volumeSlider.value / 100;
});

muteBtn.addEventListener('click', () => {
  audioElement.muted = !audioElement.muted;
  muteBtn.textContent = audioElement.muted ? 'Unmute' : 'Mute';
});