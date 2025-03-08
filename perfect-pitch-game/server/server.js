const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const GameManager = require('./gameManager');

// Initialize the database
db.init();

// Create Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// Game manager instance
const gameManager = new GameManager(io);

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// User API endpoints
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password required" });
  }
  
  const result = db.createUser(username, password);
  
  if (result.success) {
    // Don't send the password back to client
    const { password, ...userWithoutPassword } = result.user;
    res.json({ success: true, user: userWithoutPassword });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password required" });
  }
  
  const result = db.loginUser(username, password);
  
  if (result.success) {
    // Don't send the password back to client
    const { password, ...userWithoutPassword } = result.user;
    res.json({ success: true, user: userWithoutPassword });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

app.get('/api/leaderboard', (req, res) => {
  const leaderboard = db.getLeaderboard();
  res.json({ success: true, leaderboard });
});

app.get('/api/user/:id', (req, res) => {
  const user = db.getUser(req.params.id);
  
  if (user) {
    // Don't send the password back to client
    const { password, ...userWithoutPassword } = user;
    res.json({ success: true, user: userWithoutPassword });
  } else {
    res.status(404).json({ success: false, error: "User not found" });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Player authentication
  socket.on('authenticate', (data) => {
    const { userId } = data;
    const user = db.getUser(userId);
    
    if (user) {
      // Associate socket with user
      socket.userId = userId;
      socket.username = user.username;
      socket.elo = user.elo;
      
      // Send user data
      socket.emit('authenticated', { 
        success: true, 
        user: { 
          id: user.id, 
          username: user.username, 
          elo: user.elo 
        } 
      });
      
      console.log(`User ${user.username} authenticated`);
    } else {
      socket.emit('authenticated', { success: false, error: "Invalid user" });
    }
  });
  
  // Player joins matchmaking queue
  socket.on('join_queue', () => {
    if (!socket.userId) {
      socket.emit('queue_error', { error: "You must be authenticated to join the queue" });
      return;
    }
    
    const user = db.getUser(socket.userId);
    
    if (user) {
      console.log(`${user.username} joined the matchmaking queue`);
      socket.emit('queue_joined', { message: "You've joined the matchmaking queue" });
      
      // Add player to matchmaking
      gameManager.addToMatchmaking(socket);
    } else {
      socket.emit('queue_error', { error: "User not found" });
    }
  });
  
  // Player leaves matchmaking queue
  socket.on('leave_queue', () => {
    gameManager.removeFromMatchmaking(socket);
    socket.emit('queue_left', { message: "You've left the matchmaking queue" });
  });
  
  // Player makes a note guess
  socket.on('guess', (data) => {
    const { gameId, note } = data;
    
    if (!socket.userId) {
      socket.emit('game_error', { error: "You must be authenticated" });
      return;
    }
    
    gameManager.handleGuess(gameId, socket.userId, note);
  });
  
  // Player requests to replay the current note
  socket.on('replay_note', (data) => {
    const { gameId } = data;
    
    if (!socket.userId) {
      socket.emit('game_error', { error: "You must be authenticated" });
      return;
    }
    
    gameManager.replayNote(gameId, socket.userId);
  });
  
  // Player leaves mid-game
  socket.on('forfeit_game', (data) => {
    const { gameId } = data;
    
    if (!socket.userId) {
      socket.emit('game_error', { error: "You must be authenticated" });
      return;
    }
    
    gameManager.forfeitGame(gameId, socket.userId);
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    if (socket.userId) {
      // Remove from matchmaking if in queue
      gameManager.removeFromMatchmaking(socket);
      
      // Handle any active games - forfeit if player disconnects
      gameManager.handleDisconnect(socket);
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});