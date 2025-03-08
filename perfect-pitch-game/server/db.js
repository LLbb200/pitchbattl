const fs = require('fs');
const path = require('path');

// Database file paths
const USERS_FILE = path.join(__dirname, './data/users.json');
const MATCHES_FILE = path.join(__dirname, './data/matches.json');

// Ensure data directory exists
const ensureDataDir = () => {
  const dataDir = path.join(__dirname, './data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }
};

// In-memory database
let users = [];
let matches = [];

// Database methods
const db = {
  init() {
    ensureDataDir();
    
    // Load users
    try {
      if (fs.existsSync(USERS_FILE)) {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        users = JSON.parse(data);
        console.log(`Loaded ${users.length} users from database`);
      } else {
        console.log('No users database found, creating new one');
        this.saveUsers();
      }
    } catch (err) {
      console.error('Error loading users database:', err);
      this.saveUsers();
    }
    
    // Load matches
    try {
      if (fs.existsSync(MATCHES_FILE)) {
        const data = fs.readFileSync(MATCHES_FILE, 'utf8');
        matches = JSON.parse(data);
        console.log(`Loaded ${matches.length} matches from database`);
      } else {
        console.log('No matches database found, creating new one');
        this.saveMatches();
      }
    } catch (err) {
      console.error('Error loading matches database:', err);
      this.saveMatches();
    }
  },
  
  saveUsers() {
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (err) {
      console.error('Error saving users database:', err);
    }
  },
  
  saveMatches() {
    try {
      fs.writeFileSync(MATCHES_FILE, JSON.stringify(matches, null, 2));
    } catch (err) {
      console.error('Error saving matches database:', err);
    }
  },
  
  createUser(username, password) {
    // Check if username already exists
    const userExists = users.some(user => user.username.toLowerCase() === username.toLowerCase());
    if (userExists) {
      return { success: false, error: "Username already exists" };
    }
    
    // Basic validation
    if (username.length < 3) {
      return { success: false, error: "Username must be at least 3 characters" };
    }
    
    if (password.length < 4) {
      return { success: false, error: "Password must be at least 4 characters" };
    }
    
    // Create new user
    const newUser = {
      id: Date.now().toString(),
      username,
      password, // In a production environment, hash the password
      elo: 1000,
      matchesPlayed: 0,
      matchesWon: 0,
      totalRounds: 0,
      roundsWon: 0,
      created: Date.now()
    };
    
    users.push(newUser);
    this.saveUsers();
    
    return { success: true, user: newUser };
  },
  
  loginUser(username, password) {
    const user = users.find(user => 
      user.username.toLowerCase() === username.toLowerCase() && 
      user.password === password
    );
    
    if (user) {
      return { success: true, user };
    } else {
      return { success: false, error: "Invalid username or password" };
    }
  },
  
  getUser(userId) {
    return users.find(user => user.id === userId);
  },
  
  getLeaderboard() {
    return [...users]
      .filter(user => user.matchesPlayed > 0)
      .sort((a, b) => b.elo - a.elo)
      .map((user, index) => ({
        rank: index + 1,
        id: user.id,
        username: user.username,
        elo: user.elo,
        matchesPlayed: user.matchesPlayed,
        matchesWon: user.matchesWon,
        winRate: user.matchesPlayed > 0 
          ? Math.round((user.matchesWon / user.matchesPlayed) * 100) 
          : 0
      }));
  },
  
  getUserStats(userId) {
    const user = this.getUser(userId);
    if (!user) return null;
    
    const winRate = user.matchesPlayed > 0 
      ? Math.round((user.matchesWon / user.matchesPlayed) * 100) 
      : 0;
    
    const accuracy = user.totalRounds > 0 
      ? Math.round((user.roundsWon / user.totalRounds) * 100) 
      : 0;
    
    return {
      matchesPlayed: user.matchesPlayed,
      matchesWon: user.matchesWon,
      winRate,
      elo: user.elo,
      rank: this.getRankNameFromElo(user.elo),
      accuracy
    };
  },
  
  recordMatch(player1Id, player2Id, player1Score, player2Score, winnerId) {
    const match = {
      id: Date.now().toString(),
      player1Id,
      player2Id,
      player1Score,
      player2Score,
      winnerId,
      timestamp: Date.now()
    };
    
    matches.push(match);
    this.saveMatches();
    
    // Update player stats
    const player1 = this.getUser(player1Id);
    const player2 = this.getUser(player2Id);
    
    if (player1) {
      player1.matchesPlayed++;
      player1.totalRounds += player1Score + player2Score;
      player1.roundsWon += player1Score;
      if (winnerId === player1Id) player1.matchesWon++;
    }
    
    if (player2) {
      player2.matchesPlayed++;
      player2.totalRounds += player1Score + player2Score;
      player2.roundsWon += player2Score;
      if (winnerId === player2Id) player2.matchesWon++;
    }
    
    // Update ELO ratings
    if (player1 && player2) {
      const eloChange = this.updateElo(player1, player2, winnerId === player1Id);
      match.eloChange1 = eloChange.player1Change;
      match.eloChange2 = eloChange.player2Change;
    }
    
    this.saveUsers();
    return match;
  },
  
  updateElo(player1, player2, player1Won) {
    const K = 32; // K-factor
    
    // Calculate expected scores
    const expectedScore1 = 1 / (1 + Math.pow(10, (player2.elo - player1.elo) / 400));
    const expectedScore2 = 1 - expectedScore1;
    
    // Calculate actual scores
    const actualScore1 = player1Won ? 1 : 0;
    const actualScore2 = player1Won ? 0 : 1;
    
    // Calculate ELO changes
    const eloChange1 = Math.round(K * (actualScore1 - expectedScore1));
    const eloChange2 = Math.round(K * (actualScore2 - expectedScore2));
    
    // Apply ELO boost/penalty based on current ELO difference
    let finalEloChange1 = eloChange1;
    let finalEloChange2 = eloChange2;
    
    // If lower ELO player wins, they get a bonus. If higher ELO player wins, they get reduced gain
    const eloDiff = Math.abs(player1.elo - player2.elo);
    if (eloDiff > 100) {
      const multiplier = 1 + (eloDiff - 100) / 400;
      if (player1Won && player1.elo < player2.elo) {
        finalEloChange1 = Math.round(eloChange1 * multiplier);
        finalEloChange2 = Math.round(eloChange2 * multiplier);
      } else if (!player1Won && player2.elo < player1.elo) {
        finalEloChange1 = Math.round(eloChange1 * multiplier);
        finalEloChange2 = Math.round(eloChange2 * multiplier);
      } else {
        finalEloChange1 = Math.round(eloChange1 / multiplier);
        finalEloChange2 = Math.round(eloChange2 / multiplier);
      }
    }
    
    // Update player ELO ratings
    player1.elo += finalEloChange1;
    player2.elo += finalEloChange2;
    
    // Ensure minimum ELO of 100
    player1.elo = Math.max(100, player1.elo);
    player2.elo = Math.max(100, player2.elo);
    
    return {
      player1Change: finalEloChange1,
      player2Change: finalEloChange2
    };
  },
  
  getRankNameFromElo(elo) {
    const RANKS = [
      { min: 0, name: "Novice" },
      { min: 1000, name: "Apprentice" },
      { min: 1200, name: "Adept" },
      { min: 1400, name: "Expert" },
      { min: 1600, name: "Master" },
      { min: 1800, name: "Grandmaster" },
      { min: 2000, name: "Legend" },
      { min: 2200, name: "Virtuoso" }
    ];
    
    for (let i = RANKS.length - 1; i >= 0; i--) {
      if (elo >= RANKS[i].min) {
        return RANKS[i].name;
      }
    }
    return RANKS[0].name;
  }
};

module.exports = db;