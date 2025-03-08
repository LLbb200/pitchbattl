const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const db = require('./db');
const GameManager = require('./gameManager');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// MongoDB connection string - use environment variable or default to localhost
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/perfect-pitch-battle';

// Connect to MongoDB
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('Connected to MongoDB');
  // Initialize the database
  db.init();
})
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

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
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password required" });
  }
  
  try {
    const result = await db.createUser(username, password);
    
    if (result.success) {
      // Don't send the password back to client
      const { password, ...userWithoutPassword } = result.user.toObject();
      res.json({ success: true, user: userWithoutPassword });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ success: false, error: "Server error. Please try again." });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password required" });
  }
  
  try {
    const result = await db.loginUser(username, password);
    
    if (result.success) {
      // Don't send the password back to client
      const { password, ...userWithoutPassword } = result.user.toObject();
      res.json({ success: true, user: userWithoutPassword });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: "Server error. Please try again." });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await db.getLeaderboard();
    res.json({ success: true, leaderboard });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ success: false, error: "Server error. Please try again." });
  }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const user = await db.getUser(req.params.id);
    
    if (user) {
      // Don't send the password back to client
      const { password, ...userWithoutPassword } = user.toObject();
      res.json({ success: true, user: userWithoutPassword });
    } else {
      res.status(404).json({ success: false, error: "User not found" });
    }
  } catch (err) {
    console.error('User fetch error:', err);
    res.status(500).json({ success: false, error: "Server error. Please try again." });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Player authentication
  socket.on('authenticate', async (data) => {
    const { userId } = data;
    
    try {
      const user = await db.getUser(userId);
      
      if (user) {
        // Associate socket with user
        socket.userId = userId;
        socket.username = user.username;
        socket.elo = user.elo;
        
        // Send user data
        socket.emit('authenticated', { 
          success: true, 
          user: { 
            id: user._id.toString(), 
            username: user.username, 
            elo: user.elo 
          } 
        });
        
        console.log(`User ${user.username} authenticated`);
      } else {
        socket.emit('authenticated', { success: false, error: "Invalid user" });
      }
    } catch (err) {
      console.error('Socket authentication error:', err);
      socket.emit('authenticated', { success: false, error: "Server error during authentication" });
    }
  });
  
  // Player joins matchmaking queue
  socket.on('join_queue', () => {
    if (!socket.userId) {
      socket.emit('queue_error', { error: "You must be authenticated to join the queue" });
      return;
    }
    
    db.getUser(socket.userId)
      .then(user => {
        if (user) {
          console.log(`${user.username} joined the matchmaking queue`);
          socket.emit('queue_joined', { message: "You've joined the matchmaking queue" });
          
          // Add player to matchmaking
          gameManager.addToMatchmaking(socket);
        } else {
          socket.emit('queue_error', { error: "User not found" });
        }
      })
      .catch(err => {
        console.error('Join queue error:', err);
        socket.emit('queue_error', { error: "Server error. Please try again." });
      });
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
// Default port is 3000, but use environment variable if provided
const PORT = process.env.PORT || 3000;
// Listen on all network interfaces to allow external connections
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access from other devices using your server's IP address: http://SERVER_IP:${PORT}`);
});