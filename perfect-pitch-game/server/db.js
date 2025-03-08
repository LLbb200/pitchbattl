const User = require('./models/User');
const Match = require('./models/Match');
const bcrypt = require('bcrypt');

// Database methods
const db = {
  async init() {
    console.log('Database initialized');
  },
  
  async createUser(username, password) {
    // Check if username already exists
    const userExists = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
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
    
    try {
      // Hash password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);
      
      // Create new user
      const newUser = new User({
        username,
        password: hashedPassword,
        elo: 1000,
        matchesPlayed: 0,
        matchesWon: 0,
        totalRounds: 0,
        roundsWon: 0
      });
      
      await newUser.save();
      return { success: true, user: newUser };
    } catch (err) {
      console.error('Error creating user:', err);
      return { success: false, error: "Database error" };
    }
  },
  
  async loginUser(username, password) {
    try {
      // Find user by username (case insensitive)
      const user = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
      
      if (!user) {
        return { success: false, error: "Invalid username or password" };
      }
      
      // Check password
      const isMatch = await bcrypt.compare(password, user.password);
      
      if (isMatch) {
        return { success: true, user };
      } else {
        return { success: false, error: "Invalid username or password" };
      }
    } catch (err) {
      console.error('Error logging in:', err);
      return { success: false, error: "Database error" };
    }
  },
  
  async getUser(userId) {
    try {
      return await User.findById(userId);
    } catch (err) {
      console.error('Error getting user:', err);
      return null;
    }
  },
  
  async getLeaderboard() {
    try {
      const users = await User.find({ matchesPlayed: { $gt: 0 } })
        .sort({ elo: -1 })
        .select('-password'); // Exclude password field
      
      return users.map((user, index) => ({
        rank: index + 1,
        id: user._id.toString(),
        username: user.username,
        elo: user.elo,
        matchesPlayed: user.matchesPlayed,
        matchesWon: user.matchesWon,
        winRate: user.matchesPlayed > 0 
          ? Math.round((user.matchesWon / user.matchesPlayed) * 100) 
          : 0
      }));
    } catch (err) {
      console.error('Error getting leaderboard:', err);
      return [];
    }
  },
  
  async getUserStats(userId) {
    try {
      const user = await User.findById(userId);
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
    } catch (err) {
      console.error('Error getting user stats:', err);
      return null;
    }
  },
  
  async recordMatch(player1Id, player2Id, player1Score, player2Score, winnerId) {
    try {
      // Create match record
      const match = new Match({
        player1: player1Id,
        player2: player2Id,
        player1Score,
        player2Score,
        winner: winnerId || null
      });
      
      await match.save();
      
      // Update player stats
      const player1 = await User.findById(player1Id);
      const player2 = await User.findById(player2Id);
      
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
        await match.save();
      }
      
      // Save updated user stats
      if (player1) await player1.save();
      if (player2) await player2.save();
      
      return match;
    } catch (err) {
      console.error('Error recording match:', err);
      return null;
    }
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