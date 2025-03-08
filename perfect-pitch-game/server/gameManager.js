const db = require('./db');

class GameManager {
  constructor(io) {
    this.io = io;
    this.matchmakingQueue = [];
    this.activeGames = new Map();
    this.playerToGame = new Map();
    
    // Constants
    this.NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    this.TOTAL_ROUNDS = 9;
    this.ROUND_TIMEOUT = 10000; // 10 seconds max per round
    this.NEXT_ROUND_DELAY = 2000; // 2 second delay between rounds
    
    // Start the matchmaking interval
    this.startMatchmaking();
  }
  
  // Add player to matchmaking queue
  addToMatchmaking(socket) {
    // Ensure player isn't already in queue
    if (this.matchmakingQueue.some(player => player.userId === socket.userId)) {
      return;
    }
    
    // Check if player is already in a game
    if (this.playerToGame.has(socket.userId)) {
      socket.emit('queue_error', { error: "You are already in a game" });
      return;
    }
    
    // Add to queue with timestamp for potential timeout
    this.matchmakingQueue.push({
      socket,
      userId: socket.userId,
      username: socket.username,
      elo: socket.elo,
      joinTime: Date.now()
    });
    
    // Check if we can match immediately
    this.attemptMatchmaking();
  }
  
  // Remove player from matchmaking queue
  removeFromMatchmaking(socket) {
    this.matchmakingQueue = this.matchmakingQueue.filter(
      player => player.userId !== socket.userId
    );
  }
  
  // Try to match players in the queue
  startMatchmaking() {
    // Run matchmaking check every few seconds
    setInterval(() => {
      this.attemptMatchmaking();
    }, 3000);
  }
  
  attemptMatchmaking() {
    // Need at least 2 players to make a match
    if (this.matchmakingQueue.length < 2) return;
    
    // Sort by join time (oldest first)
    this.matchmakingQueue.sort((a, b) => a.joinTime - b.joinTime);
    
    // For each player in queue, try to find a suitable opponent
    for (let i = 0; i < this.matchmakingQueue.length; i++) {
      const player = this.matchmakingQueue[i];
      
      // Skip players who are no longer connected
      if (!player.socket.connected) {
        this.matchmakingQueue.splice(i, 1);
        i--;
        continue;
      }
      
      // Find best match for this player
      let bestMatch = null;
      let bestScore = Infinity;
      
      for (let j = 0; j < this.matchmakingQueue.length; j++) {
        if (i === j) continue; // Skip self
        
        const opponent = this.matchmakingQueue[j];
        
        // Skip players who are no longer connected
        if (!opponent.socket.connected) continue;
        
        // Calculate matchmaking score (lower is better)
        // Based on ELO difference and wait time
        const eloDiff = Math.abs(player.elo - opponent.elo);
        const waitTimeDiff = Math.abs(player.joinTime - opponent.joinTime);
        
        // Score is primarily based on ELO difference, but wait time is also a factor
        // This ensures players don't wait too long for a match
        const playerWaitTime = Date.now() - player.joinTime;
        const opponentWaitTime = Date.now() - opponent.joinTime;
        
        // The longer players have waited, the more we prioritize making a match
        // regardless of ELO difference
        const waitTimeMultiplier = Math.max(
          1 - Math.max(playerWaitTime, opponentWaitTime) / 30000, // Reduce importance of ELO diff after 30 seconds
          0.2 // Always consider ELO diff at least 20%
        );
        
        const score = eloDiff * waitTimeMultiplier;
        
        if (score < bestScore) {
          bestScore = score;
          bestMatch = opponent;
        }
      }
      
      // If we found a match, create a game
      if (bestMatch) {
        this.createGame(player, bestMatch);
        
        // Remove both players from queue
        this.removeFromMatchmaking(player.socket);
        this.removeFromMatchmaking(bestMatch.socket);
        
        // Since queue has changed, restart matchmaking from beginning
        this.attemptMatchmaking();
        break;
      }
    }
  }
  
  // Create a new game between two players
  createGame(player1, player2) {
    const gameId = `game_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    
    // Create game object
    const game = {
      id: gameId,
      player1: {
        id: player1.userId,
        username: player1.username,
        elo: player1.elo,
        socket: player1.socket,
        score: 0
      },
      player2: {
        id: player2.userId,
        username: player2.username,
        elo: player2.elo,
        socket: player2.socket,
        score: 0
      },
      round: 1,
      totalRounds: this.TOTAL_ROUNDS,
      currentNote: null,
      state: 'starting', // starting, round_active, round_ended, game_ended
      roundStartTime: 0,
      roundTimeout: null,
      winnerId: null
    };
    
    // Store game
    this.activeGames.set(gameId, game);
    this.playerToGame.set(player1.userId, gameId);
    this.playerToGame.set(player2.userId, gameId);
    
    // Notify players about the match
    player1.socket.join(gameId);
    player2.socket.join(gameId);
    
    this.io.to(gameId).emit('game_found', {
      gameId,
      player1: {
        id: player1.userId,
        username: player1.username,
        elo: player1.elo
      },
      player2: {
        id: player2.userId,
        username: player2.username,
        elo: player2.elo
      },
      round: 1,
      totalRounds: this.TOTAL_ROUNDS
    });
    
    // Start the first round after a short delay
    setTimeout(() => {
      this.startRound(gameId);
    }, 3000);
  }
  
  // Start a new round
  startRound(gameId) {
    const game = this.activeGames.get(gameId);
    if (!game) return;
    
    // Pick a random note
    const randomNote = this.NOTES[Math.floor(Math.random() * this.NOTES.length)];
    game.currentNote = randomNote;
    game.state = 'round_active';
    game.roundStartTime = Date.now();
    
    // Clear any existing timeout
    if (game.roundTimeout) {
      clearTimeout(game.roundTimeout);
    }
    
    // Set a timeout for the round
    game.roundTimeout = setTimeout(() => {
      this.endRound(gameId, null);
    }, this.ROUND_TIMEOUT);
    
    // Notify players about the new round
    this.io.to(gameId).emit('round_start', {
      round: game.round,
      note: randomNote
    });
  }
  
  // Handle player guess
  handleGuess(gameId, playerId, note) {
    const game = this.activeGames.get(gameId);
    if (!game || game.state !== 'round_active') return;
    
    // Check if the guess is correct
    const isCorrect = note === game.currentNote;
    
    this.io.to(gameId).emit('player_guess', {
      playerId,
      note,
      correct: isCorrect
    });
    
    if (isCorrect) {
      // Update score for the player who guessed correctly
      if (playerId === game.player1.id) {
        game.player1.score++;
      } else if (playerId === game.player2.id) {
        game.player2.score++;
      }
      
      // End the round
      this.endRound(gameId, playerId);
    }
  }
  
  // End the current round
  endRound(gameId, winnerId) {
    const game = this.activeGames.get(gameId);
    if (!game || game.state === 'round_ended' || game.state === 'game_ended') return;
    
    // Clear round timeout
    if (game.roundTimeout) {
      clearTimeout(game.roundTimeout);
      game.roundTimeout = null;
    }
    
    game.state = 'round_ended';
    
    // Notify players about the round result
    this.io.to(gameId).emit('round_end', {
      round: game.round,
      note: game.currentNote,
      winnerId,
      player1Score: game.player1.score,
      player2Score: game.player2.score
    });
    
    // Check if game is over
    if (game.round >= game.totalRounds) {
      this.endGame(gameId);
    } else {
      // Start next round after delay
      game.round++;
      
      setTimeout(() => {
        this.startRound(gameId);
      }, this.NEXT_ROUND_DELAY);
    }
  }
  
  // End the game and update ELO
  endGame(gameId) {
    const game = this.activeGames.get(gameId);
    if (!game || game.state === 'game_ended') return;
    
    game.state = 'game_ended';
    
    // Determine winner
    let winnerId = null;
    if (game.player1.score > game.player2.score) {
      winnerId = game.player1.id;
    } else if (game.player2.score > game.player1.score) {
      winnerId = game.player2.id;
    }
    // If tied, winnerId remains null
    
    game.winnerId = winnerId;
    
    // Record match in database
    const match = db.recordMatch(
      game.player1.id,
      game.player2.id,
      game.player1.score,
      game.player2.score,
      winnerId
    );
    
    // Get updated player info
    const player1 = db.getUser(game.player1.id);
    const player2 = db.getUser(game.player2.id);
    
    // Notify players about the game result
    this.io.to(gameId).emit('game_end', {
      gameId,
      player1: {
        id: game.player1.id,
        username: game.player1.username,
        score: game.player1.score,
        newElo: player1.elo,
        eloChange: match.eloChange1
      },
      player2: {
        id: game.player2.id,
        username: game.player2.username,
        score: game.player2.score,
        newElo: player2.elo,
        eloChange: match.eloChange2
      },
      winnerId
    });
    
    // Clean up game resources after a delay
    setTimeout(() => {
      this.cleanupGame(gameId);
    }, 10000); // Keep game data for 10 seconds so players can see results
  }
  
  // Clean up game resources
  cleanupGame(gameId) {
    const game = this.activeGames.get(gameId);
    if (!game) return;
    
    // Remove player mappings
    this.playerToGame.delete(game.player1.id);
    this.playerToGame.delete(game.player2.id);
    
    // Remove game
    this.activeGames.delete(gameId);
  }
  
  // Handle player replay note request
  replayNote(gameId, playerId) {
    const game = this.activeGames.get(gameId);
    if (!game || game.state !== 'round_active') return;
    
    // Send the note just to the requesting player
    const socket = game.player1.id === playerId ? game.player1.socket : game.player2.socket;
    socket.emit('replay_note', {
      note: game.currentNote
    });
  }
  
  // Handle player forfeit
  forfeitGame(gameId, playerId) {
    const game = this.activeGames.get(gameId);
    if (!game) return;
    
    // Determine winner (the player who didn't forfeit)
    const winnerId = game.player1.id === playerId ? game.player2.id : game.player1.id;
    
    // If player1 forfeited, give all remaining rounds to player2, and vice versa
    const remainingRounds = game.totalRounds - (game.player1.score + game.player2.score);
    
    if (game.player1.id === playerId) {
      game.player2.score += remainingRounds;
    } else {
      game.player1.score += remainingRounds;
    }
    
    // End the game
    game.state = 'game_ended';
    game.winnerId = winnerId;
    
    // Record match in database
    const match = db.recordMatch(
      game.player1.id,
      game.player2.id,
      game.player1.score,
      game.player2.score,
      winnerId
    );
    
    // Get updated player info
    const player1 = db.getUser(game.player1.id);
    const player2 = db.getUser(game.player2.id);
    
    // Notify players about the forfeit
    this.io.to(gameId).emit('game_forfeit', {
      gameId,
      forfeitedById: playerId,
      player1: {
        id: game.player1.id,
        username: game.player1.username,
        score: game.player1.score,
        newElo: player1.elo,
        eloChange: match.eloChange1
      },
      player2: {
        id: game.player2.id,
        username: game.player2.username,
        score: game.player2.score,
        newElo: player2.elo,
        eloChange: match.eloChange2
      },
      winnerId
    });
    
    // Clean up game resources after a delay
    setTimeout(() => {
      this.cleanupGame(gameId);
    }, 10000);
  }
  
  // Handle player disconnect
  handleDisconnect(socket) {
    const playerId = socket.userId;
    if (!playerId) return;
    
    // Check if player is in an active game
    const gameId = this.playerToGame.get(playerId);
    if (gameId) {
      const game = this.activeGames.get(gameId);
      if (game && (game.state === 'starting' || game.state === 'round_active')) {
        // Forfeit the game
        this.forfeitGame(gameId, playerId);
      }
    }
  }
}

module.exports = GameManager;