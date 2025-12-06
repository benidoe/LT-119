const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow CORS for your GitHub Pages domain
const io = new Server(server, {
  cors: {
    origin: "https://benidoe.github.io/LT-119", // your Pages URL (no trailing slash)
    methods: ["GET", "POST"]
  }
});

// Serve static files from root
app.use(express.static(__dirname));
app.use('/assets', express.static(__dirname + '/assets')); // serve sound assets

// Basic route
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Track usernames, channels, and mic locks
const userNames = {};
const userChannels = {};
const channelTalkers = {}; // { channel: socketId }

// Helper: broadcast user list for a channel
function broadcastUserList(channel) {
  const usersInChannel = Object.entries(userChannels)
    .filter(([id, ch]) => ch === channel)
    .map(([id]) => ({ 
      id, 
      username: userNames[id], 
      talking: channelTalkers[channel] === id // Include talking status
    }));
  io.to(channel).emit('userList', usersInChannel);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Join channel
  socket.on('joinChannel', ({ channel, username }) => {
    const current = userChannels[socket.id];

    // Prevent re-joining same channel
    if (current === channel) {
      socket.emit('activeChannel', channel);
      broadcastUserList(channel);
      return;
    }

    // Leave old channel if exists
    if (current) {
      // Clean up old channel state
      if (channelTalkers[current] === socket.id) {
          delete channelTalkers[current];
      }
      socket.leave(current);
      // Inform peers of departure before updating the list of the old channel
      socket.to(current).emit('peerLeft', { id: socket.id });
      broadcastUserList(current);
    }

    // Join new channel
    userNames[socket.id] = username;
    userChannels[socket.id] = channel;
    socket.join(channel);

    console.log(`${username} (${socket.id}) joined ${channel}`);

    // Confirm active channel + send updated list
    socket.emit('activeChannel', channel);
    broadcastUserList(channel);

    // Notify others so they can start WebRTC handshakes
    socket.to(channel).emit('peerJoined', { id: socket.id, username });
  });

  // Leave channel
  socket.on('leaveChannel', () => { // Removed unused parameters
    const current = userChannels[socket.id];
    if (!current) {
      socket.emit('activeChannel', null); // Reset client state just in case
      return;
    }

    // Release mic if this user was talking
    if (channelTalkers[current] === socket.id) {
      delete channelTalkers[current];
      io.to(current).emit('userTalking', {
        id: socket.id,
        username: userNames[socket.id],
        talking: false
      });
    }

    socket.leave(current);
    delete userChannels[socket.id];
    delete userNames[socket.id]; // Clean up username tracking too

    console.log(`User ${socket.id} left ${current}`);

    // Inform peers to close connections
    socket.to(current).emit('peerLeft', { id: socket.id });
    
    // Update user list for channel left (must be done after channelTalkers/userNames cleanup)
    broadcastUserList(current);

    // Reset client state
    socket.emit('activeChannel', null);
    socket.emit('userList', []);
  });

  // Talking indicators with mic priority (kept for UI/UX)
  socket.on('startTalking', (channel) => {
    if (userChannels[socket.id] !== channel) return;

    // Only allow talking if no one else is currently holding the lock
    if (!channelTalkers[channel]) {
      channelTalkers[channel] = socket.id;
      io.to(channel).emit('userTalking', {
        id: socket.id,
        username: userNames[socket.id],
        talking: true
      });
      broadcastUserList(channel); // Update list to show talking status for new users
    } else if (channelTalkers[channel] !== socket.id) {
      // Someone else is already talking - notify the client
      socket.emit('channelBusy', channel);
    }
  });

  socket.on('stopTalking', (channel) => {
    if (channelTalkers[channel] === socket.id) {
      delete channelTalkers[channel];
      io.to(channel).emit('userTalking', {
        id: socket.id,
        username: userNames[socket.id],
        talking: false
      });
      broadcastUserList(channel); // Update list to clear talking status
    }
  });

  // WebRTC signaling (replaces audioChunk transport)
  socket.on('offer', ({ channel, offer, to }) => {
    // Send the offer to a specific peer in the same channel
    if (to) {
      io.to(to).emit('offer', { id: socket.id, offer });
    }
  });

  socket.on('answer', ({ channel, answer, to }) => {
    // Send the answer back to the original offerer
    if (to) {
      io.to(to).emit('answer', { id: socket.id, answer });
    }
  });

  socket.on('iceCandidate', ({ candidate, to }) => {
    // Forward ICE candidates to the right peer (channel is not needed for forwarding)
    if (to) {
      io.to(to).emit('iceCandidate', { id: socket.id, candidate });
    }
  });

  // Disconnect cleanup
  socket.on('disconnect', () => {
    const channel = userChannels[socket.id];

    // Release mic if this user was talking
    if (channelTalkers[channel] === socket.id) {
      delete channelTalkers[channel];
      io.to(channel).emit('userTalking', {
        id: socket.id,
        username: userNames[socket.id],
        talking: false
      });
    }

    // Inform peers of departure
    if (channel) {
      socket.to(channel).emit('peerLeft', { id: socket.id });
    }

    delete userNames[socket.id];
    delete userChannels[socket.id];
    
    if (channel) {
      broadcastUserList(channel);
    }
    console.log('Disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});