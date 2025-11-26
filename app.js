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
const activeChannelDiv = document.getElementById('activeChannel');


let currentChannel = null;
let username = null;


// WebRTC state
let localStream = null;
let micTrack = null;
let peerConnections = {};
let remoteAudios = {};
let muted = false;


// Silence detection
let audioContext;
let analyser;
let sourceNode;
let silenceThreshold = 0.02;
let staticPlaying = false;
let silenceStart = null;


// Web Audio API static sound
let staticBuffer;
let staticSource;


// Beep sounds
const beepOn = new Audio('assets/sound/beep-on.mp3');
const beepOff = new Audio('assets/sound/beep-off.mp3');


// Helper function to update the status message
function updateStatus(message, type = 'info') {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
    // Clear status after 5 seconds if not an error
    if (type !== 'error') {
        setTimeout(() => {
            if (statusDiv.textContent === message) {
                statusDiv.textContent = '';
                statusDiv.className = 'status';
            }
        }, 5000);
    }
}


// Unlock audio context and preload beep sounds on first gesture
function unlockAudio() {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
    }
    beepOn.load();
    beepOff.load();
    document.removeEventListener('click', unlockAudio);
    document.removeEventListener('touchstart', unlockAudio);
}
document.addEventListener('click', unlockAudio);
document.addEventListener('touchstart', unlockAudio);


// Function to stop all WebRTC and local audio activity
function cleanupWebRTC() {
    // 1. Stop local tracks
    if (micTrack) {
        micTrack.stop();
        micTrack = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // 2. Close all peer connections
    Object.values(peerConnections).forEach(pc => {
        try { pc.close(); } catch (e) { console.warn("Error closing peer connection:", e); }
    });
    peerConnections = {};

    // 3. Stop remote audios
    Object.values(remoteAudios).forEach(audio => {
        try { audio.pause(); } catch {}
        if (audio.parentNode) audio.parentNode.removeChild(audio);
    });
    remoteAudios = {};

    // 4. Stop static sound if playing
    stopStaticSound();

    // 5. Clean up Web Audio API nodes
    if (sourceNode) {
        try { sourceNode.disconnect(); } catch {}
        sourceNode = null;
    }
    if (analyser) {
        try { analyser.disconnect(); } catch {}
        analyser = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
        // We generally keep the audioContext open for performance, but clean up nodes.
        // If we needed to fully stop, we'd use audioContext.close();
    }
}


// Start static sound (squelch) for remote users
function startStaticSound(peerId) {
    if (remoteAudios[peerId] && !staticPlaying) {
        if (!staticBuffer) {
            // Lazy load the static sound buffer
            loadStaticSound(() => {
                if (staticBuffer) {
                    playStatic(peerId);
                }
            });
        } else {
            playStatic(peerId);
        }
    }
}

function loadStaticSound(callback) {
    const context = audioContext || (audioContext = new (window.AudioContext || window.webkitAudioContext)());
    fetch('assets/sound/static-loop.mp3')
        .then(response => response.arrayBuffer())
        .then(data => context.decodeAudioData(data))
        .then(buffer => {
            staticBuffer = buffer;
            if (callback) callback();
        })
        .catch(error => console.error('Error loading static sound:', error));
}

function playStatic(peerId) {
    if (!staticBuffer) return;
    stopStaticSound(); // Ensure only one instance runs

    const context = audioContext || (audioContext = new (window.AudioContext || window.webkitAudioContext)());
    staticSource = context.createBufferSource();
    staticSource.buffer = staticBuffer;
    staticSource.loop = true;

    const gainNode = context.createGain();
    gainNode.gain.value = 0.3; // Adjust volume for squelch

    staticSource.connect(gainNode);
    // Connect to the remote audio output, which is the destination
    gainNode.connect(context.destination);

    staticSource.start(0);
    staticPlaying = true;
    console.log('Static sound started.');
}

function stopStaticSound() {
    if (staticSource) {
        try {
            staticSource.stop();
            staticSource.disconnect();
        } catch (e) {
            console.warn("Error stopping static sound:", e);
        }
        staticSource = null;
        staticPlaying = false;
        console.log('Static sound stopped.');
    }
}


// WebRTC: Create a peer connection to a specific peer
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
            // Append to body but keep it hidden as it only contains audio
            audio.style.display = 'none';
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
        console.log(`Peer ${peerId} connection state: ${pc.connectionState}`);
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


// WebRTC: Add local track to all peer connections
function addLocalTrack() {
    if (micTrack && localStream) {
        Object.values(peerConnections).forEach(pc => {
            // Check if track is already added to avoid duplicates
            if (!pc.getSenders().some(sender => sender.track === micTrack)) {
                pc.addTrack(micTrack, localStream);
            }
        });
    }
}


// WebRTC: Remove local track from all peer connections
function removeLocalTrack() {
    Object.values(peerConnections).forEach(pc => {
        pc.getSenders().forEach(sender => {
            if (sender.track === micTrack) {
                pc.removeTrack(sender);
            }
        });
    });
}


// WebRTC: Handle new peer joining (initiate offer)
async function handleNewPeer(peerId) {
    const pc = createPeerConnection(peerId);

    // Add local track before creating offer
    if (micTrack && localStream) {
        pc.addTrack(micTrack, localStream);
    }

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { channel: currentChannel, offer: pc.localDescription, to: peerId });
    } catch (error) {
        console.error('Error creating offer:', error);
    }
}


// Event Handlers //

joinBtn.onclick = async () => {
    username = usernameInput.value.trim();
    currentChannel = channelSelect.value;

    if (!username) {
        updateStatus('Please enter a username.', 'error');
        return;
    }
    if (!currentChannel) {
        updateStatus('Please select a channel.', 'error');
        return;
    }

    // 1. Request microphone access
    try {
        updateStatus(`Requesting microphone access...`, 'info');
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        micTrack = localStream.getAudioTracks()[0];
    } catch (error) {
        console.error('Microphone access denied:', error);
        updateStatus('Microphone access denied. Cannot join channel.', 'error');
        return;
    }

    // 2. Start Socket.IO join process
    updateStatus(`Joined channel ${currentChannel} as ${username}...`, 'info');
    socket.emit('joinChannel', { channel: currentChannel, username: username });

    // 3. Enable PTT button and controls
    pttBtn.disabled = false;
    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    usernameInput.disabled = true;
    channelSelect.disabled = true;
    muteBtn.disabled = false;

    // 4. Initialize Web Audio API for silence detection (VOX)
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    sourceNode = audioContext.createMediaStreamSource(localStream);
    analyser = audioContext.createAnalyser();
    sourceNode.connect(analyser);
    // Start VOX monitoring loop
    monitorAudioLevel();
};

leaveBtn.onclick = () => {
    if (currentChannel) {
        socket.emit('leaveChannel', { channel: currentChannel });
        updateStatus(`Leaving channel ${currentChannel}...`, 'info');

        // Clean up WebRTC and audio
        cleanupWebRTC();

        // Update UI state
        currentChannel = null;
        activeChannelDiv.textContent = 'No channel joined';
        usersDiv.innerHTML = '';
        updateStatus('Left channel.', 'info');

        // Disable PTT button and controls
        pttBtn.disabled = true;
        pttBtn.classList.remove('active');
        joinBtn.disabled = false;
        leaveBtn.disabled = true;
        usernameInput.disabled = false;
        channelSelect.disabled = false;
        muteBtn.disabled = true;
    }
};

pttBtn.onmousedown = pttBtn.ontouchstart = (e) => {
    if (e.cancelable) e.preventDefault();
    if (!pttBtn.disabled) {
        if (currentChannel) {
            socket.emit('startTalking', { channel: currentChannel });
            pttBtn.classList.add('active');
            beepOn.play();
        }
    }
};

pttBtn.onmouseup = pttBtn.ontouchend = () => {
    if (currentChannel) {
        socket.emit('stopTalking', { channel: currentChannel });
        pttBtn.classList.remove('active');
        beepOff.play();
    }
};

muteBtn.onclick = () => {
    muted = !muted;
    muteBtn.classList.toggle('active', muted);
    muteBtn.textContent = muted ? 'Unmute Speaker' : 'Mute Speaker';

    // Apply mute state to all remote audios
    Object.values(remoteAudios).forEach(audio => {
        audio.muted = muted;
    });
};


// Web Audio API VOX monitoring function
function monitorAudioLevel() {
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // Calculate RMS for volume level
    let sumOfSquares = 0;
    for (const amplitude of dataArray) {
        sumOfSquares += amplitude * amplitude;
    }
    const rms = Math.sqrt(sumOfSquares / dataArray.length) / 255; // Normalize to 0-1

    const isSilent = rms < silenceThreshold;

    if (isSilent) {
        if (silenceStart === null) {
            silenceStart = Date.now();
        } else if (Date.now() - silenceStart > 1000) { // 1 second of silence
            // Automatically release mic lock if user is not actively holding PTT
            if (!pttBtn.classList.contains('active')) {
                socket.emit('stopTalking', { channel: currentChannel });
            }
            silenceStart = null; // Reset to avoid constant re-sending
        }
    } else {
        silenceStart = null;
        // Automatically request mic lock if user is not already talking
        if (!pttBtn.classList.contains('active')) {
            // Note: VOX-based talking logic is currently disabled in favor of PTT
            // socket.emit('startTalking', { channel: currentChannel });
        }
    }

    requestAnimationFrame(monitorAudioLevel);
}


// Socket.IO Event Listeners //

socket.on('connect', () => {
    console.log('Connected to server with ID:', socket.id);
    updateStatus('Connected to server.', 'success');
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');
    updateStatus('Disconnected from server. Reconnecting...', 'error');
    // Clear WebRTC state on unexpected disconnect
    cleanupWebRTC();
});

socket.on('joinSuccess', ({ channel, username: name, peers }) => {
    // *** FIX IMPLEMENTATION: Update status indicator after successful join ***
    currentChannel = channel;
    username = name;
    updateStatus(`Joined channel ${channel} as ${username}.`, 'success');
    activeChannelDiv.textContent = `Active Channel: ${channel}`;

    // Initiate WebRTC connections with all existing peers
    peers.forEach(peerId => {
        if (peerId !== socket.id) {
            handleNewPeer(peerId);
        }
    });
});

socket.on('joinFailed', (message) => {
    updateStatus(`Join failed: ${message}`, 'error');
    // Clean up local tracks if join failed after getting mic access
    cleanupWebRTC();
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
    usernameInput.disabled = false;
    channelSelect.disabled = false;
    pttBtn.disabled = true;
    activeChannelDiv.textContent = 'No channel joined';
});

socket.on('peerJoined', ({ id: peerId, username: peerUsername }) => {
    console.log(`Peer joined: ${peerUsername} (${peerId})`);
    // Create connection and wait for offer
    createPeerConnection(peerId);
    // Peer who joined is responsible for sending the offer
});

socket.on('peerLeft', ({ id: peerId }) => {
    console.log(`Peer left: ${peerId}`);
    // Cleanup WebRTC connection
    if (peerConnections[peerId]) {
        try { peerConnections[peerId].close(); } catch {}
        delete peerConnections[peerId];
    }
    const audio = remoteAudios[peerId];
    if (audio) {
        try { audio.pause(); } catch {}
        if (audio.parentNode) audio.parentNode.removeChild(audio);
        delete remoteAudios[peerId];
    }
});

socket.on('userList', (users) => {
    usersDiv.innerHTML = '<h3>Users in Channel</h3>';
    users.forEach(user => {
        const userElement = document.createElement('div');
        userElement.className = 'user-item';
        userElement.id = `user-${user.id}`;
        userElement.textContent = user.username + (user.id === socket.id ? ' (You)' : '');
        usersDiv.appendChild(userElement);
    });
});

socket.on('userTalking', ({ id, username: name, talking }) => {
    const userElement = document.getElementById(`user-${id}`);
    if (userElement) {
        userElement.classList.toggle('talking', talking);
    }

    if (talking) {
        // User started talking, stop static
        stopStaticSound();
        // Play audio from this peer (handled by WebRTC ontrack)
    } else {
        // User stopped talking, start static sound for atmosphere
        startStaticSound(id);
    }
});


// WebRTC Signaling Handlers

socket.on('offer', async ({ id: peerId, offer }) => {
    console.log('Received offer from:', peerId);
    const pc = peerConnections[peerId] || createPeerConnection(peerId);

    // Add local track before setting remote description and creating answer
    if (micTrack && localStream) {
        pc.addTrack(micTrack, localStream);
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { channel: currentChannel, answer: pc.localDescription, to: peerId });
    } catch (error) {
        console.error('Error handling offer:', error);
    }
});

socket.on('answer', async ({ id: peerId, answer }) => {
    console.log('Received answer from:', peerId);
    const pc = peerConnections[peerId];
    if (pc) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }
});

socket.on('iceCandidate', async ({ id: peerId, candidate }) => {
    const pc = peerConnections[peerId];
    if (pc && candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }
});