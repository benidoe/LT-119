const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow CORS for your GitHub Pages domain
const io = new Server(server, {
  cors: {
    origin: "https://benidoe.github.io/LT-119/", // replace with your actual Pages URL
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
    .map(([id]) => ({ id, username: userNames[id] }));
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
      socket.leave(current);
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
  });

  // Leave channel
  socket.on('leaveChannel', () => {
    const current = userChannels[socket.id];
    if (!current) return;

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

    console.log(`User ${socket.id} left ${current}`);

    // Update user list for channel left
    broadcastUserList(current);

    // Reset client state
    socket.emit('activeChannel', null);
    socket.emit('userList', []);
  });

  // Talking indicators with mic priority
  socket.on('startTalking', (channel) => {
    if (userChannels[socket.id] !== channel) return;

    // If channel is free, lock mic
    if (!channelTalkers[channel]) {
      channelTalkers[channel] = socket.id;
      io.to(channel).emit('userTalking', {
        id: socket.id,
        username: userNames[socket.id],
        talking: true
      });
    } else {
      // Someone else is already talking
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
    }
  });

  // Audio chunks only if mic is locked to this user
  socket.on('audioChunk', (data) => {
    const current = userChannels[socket.id];
    if (!current || current !== data.channel) return;
    if (channelTalkers[current] !== socket.id) return; // mic priority guard

    socket.to(data.channel).emit('audioChunk', {
      id: socket.id,
      chunk: data.chunk
    });
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