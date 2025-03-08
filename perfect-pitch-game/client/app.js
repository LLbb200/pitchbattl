// Initialize dark mode based on user preference
if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark');
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
    if (event.matches) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
});

// Constants
// Use the server's actual IP address or hostname for API_URL
// For development on the same machine use: http://localhost:3000
// For production, use the server's IP address or domain name
const API_URL = window.location.hostname === 'localhost' 
    ? 'http://localhost:3000' 
    : window.location.origin;

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const TOTAL_ROUNDS = 9;
const ROUND_TIMEOUT = 10000; // 10 seconds

// ELO rank thresholds and names
const RANKS = [
    { min: 0, name: "Novice", class: "badge-novice" },
    { min: 1000, name: "Apprentice", class: "badge-apprentice" },
    { min: 1200, name: "Adept", class: "badge-adept" },
    { min: 1400, name: "Expert", class: "badge-expert" },
    { min: 1600, name: "Master", class: "badge-master" },
    { min: 1800, name: "Grandmaster", class: "badge-grandmaster" },
    { min: 2000, name: "Legend", class: "badge-legend" },
    { min: 2200, name: "Virtuoso", class: "badge-virtuoso" }
];

// Game state
let currentUser = null;
let socket = null;
let inQueue = false;
let queueStartTime = 0;
let activeGame = null;
let roundTimerInterval = null;
let roundEndTime = 0;

// Audio context for playing notes
let audioContext = null;

// Initialize the socket connection
function connectSocket() {
    if (socket) return;
    
    console.log('Connecting to server at:', API_URL);
    socket = io(API_URL);
    
    // Socket event handlers
    socket.on('connect', () => {
        console.log('Connected to server');
        
        // If user is already logged in, authenticate the socket
        if (currentUser) {
            authenticateSocket();
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        showNotification('Disconnected from server. Please reload the page.', 'error');
    });
    
    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        showNotification('Failed to connect to server. Please check your connection and reload the page.', 'error');
    });
    
    socket.on('authenticated', (data) => {
        if (data.success) {
            console.log('Socket authenticated');
        } else {
            console.error('Socket authentication failed:', data.error);
            showNotification('Authentication failed. Please log in again.', 'error');
        }
    });
    
    socket.on('queue_joined', (data) => {
        console.log(data.message);
        inQueue = true;
        queueStartTime = Date.now();
        updateQueueUI(true);
    });
    
    socket.on('queue_left', (data) => {
        console.log(data.message);
        inQueue = false;
        updateQueueUI(false);
    });
    
    socket.on('queue_error', (data) => {
        console.error('Queue error:', data.error);
        showNotification(data.error, 'error');
        inQueue = false;
        updateQueueUI(false);
    });
    
    socket.on('game_found', (data) => {
        console.log('Game found:', data);
        inQueue = false;
        activeGame = {
            id: data.gameId,
            player1: data.player1,
            player2: data.player2,
            round: data.round,
            totalRounds: data.totalRounds,
            player1Score: 0,
            player2Score: 0,
            currentNote: null,
            isPlayer1: data.player1.id === currentUser.id
        };
        
        startGame();
    });
    
    socket.on('round_start', (data) => {
        console.log('Round start:', data);
        activeGame.round = data.round;
        activeGame.currentNote = data.note;
        
        startRound();
    });
    
    socket.on('player_guess', (data) => {
        console.log('Player guess:', data);
        const isCurrentUser = data.playerId === currentUser.id;
        
        // Highlight the button based on correctness
        const button = document.querySelector(`.note-btn[data-note="${data.note}"]`);
        if (button) {
            if (data.correct) {
                button.classList.add('correct');
            } else {
                button.classList.add('incorrect');
                
                // Remove incorrect highlight after a short delay
                setTimeout(() => {
                    button.classList.remove('incorrect');
                }, 500);
            }
        }
        
        // Update game status if the guess was correct
        if (data.correct) {
            const gameStatus = document.getElementById('game-status');
            
            if (isCurrentUser) {
                gameStatus.textContent = 'You guessed correctly!';
                gameStatus.className = 'mb-6 text-center text-lg font-semibold text-success';
            } else {
                const opponentName = activeGame.isPlayer1 ? activeGame.player2.username : activeGame.player1.username;
                gameStatus.textContent = `${opponentName} guessed correctly!`;
                gameStatus.className = 'mb-6 text-center text-lg font-semibold text-danger';
            }
        }
    });
    
    socket.on('round_end', (data) => {
        console.log('Round end:', data);
        
        // Update scores
        if (activeGame.isPlayer1) {
            activeGame.player1Score = data.player1Score;
            activeGame.player2Score = data.player2Score;
        } else {
            activeGame.player1Score = data.player2Score;
            activeGame.player2Score = data.player1Score;
        }
        
        document.getElementById('player-score').textContent = activeGame.isPlayer1 ? data.player1Score : data.player2Score;
        document.getElementById('opponent-score').textContent = activeGame.isPlayer1 ? data.player2Score : data.player1Score;
        
        // Show the correct note
        revealNote(data.note, data.winnerId);
        
        // Stop round timer
        clearRoundTimer();
    });
    
    socket.on('game_end', (data) => {
        console.log('Game end:', data);
        
        // Determine if current user won
        const isWinner = data.winnerId === currentUser.id;
        const isTie = data.winnerId === null;
        
        // Update user's ELO (if they were involved in the game)
        if (data.player1.id === currentUser.id) {
            currentUser.elo = data.player1.newElo;
        } else if (data.player2.id === currentUser.id) {
            currentUser.elo = data.player2.newElo;
        }
        
        // Show game results after a short delay
        setTimeout(() => {
            showGameResults(data, isWinner, isTie);
        }, 1500);
    });
    
    socket.on('game_forfeit', (data) => {
        console.log('Game forfeit:', data);
        
        const forfeiter = data.forfeitedById;
        const isCurrentUserForfeit = forfeiter === currentUser.id;
        
        // Update user's ELO (if they were involved in the game)
        if (data.player1.id === currentUser.id) {
            currentUser.elo = data.player1.newElo;
        } else if (data.player2.id === currentUser.id) {
            currentUser.elo = data.player2.newElo;
        }
        
        // Show forfeit message
        if (activeGame) {
            const gameStatus = document.getElementById('game-status');
            
            if (isCurrentUserForfeit) {
                gameStatus.textContent = 'You forfeited the game';
                gameStatus.className = 'mb-6 text-center text-lg font-semibold text-danger';
            } else {
                const opponentName = activeGame.isPlayer1 ? activeGame.player2.username : activeGame.player1.username;
                gameStatus.textContent = `${opponentName} forfeited the game`;
                gameStatus.className = 'mb-6 text-center text-lg font-semibold text-success';
            }
            
            // Show game results after a short delay
            setTimeout(() => {
                showGameResults(data, !isCurrentUserForfeit, false);
            }, 1500);
        }
    });
    
    socket.on('replay_note', (data) => {
        if (data.note) {
            playNote(data.note);
        }
    });
    
    socket.on('game_error', (data) => {
        console.error('Game error:', data.error);
        showNotification(data.error, 'error');
    });
}

// Authenticate the socket connection with user ID
function authenticateSocket() {
    if (!socket || !currentUser) return;
    
    socket.emit('authenticate', {
        userId: currentUser.id
    });
}

// Initialize the app
function initApp() {
    // Create audio context
    try {
        window.AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext();
    } catch (e) {
        console.log("Web Audio API is not supported in this browser", e);
        showNotification("Your browser doesn't support Web Audio API. Some features may not work.", 'warning');
    }
    
    // Setup event listeners for login/registration
    document.getElementById("login-tab").addEventListener("click", showLoginForm);
    document.getElementById("register-tab").addEventListener("click", showRegisterForm);
    document.getElementById("login-btn").addEventListener("click", handleLogin);
    document.getElementById("register-btn").addEventListener("click", handleRegister);
    
    // Setup game navigation
    document.getElementById("play-match-btn").addEventListener("click", joinMatchmaking);
    document.getElementById("cancel-queue-btn").addEventListener("click", cancelMatchmaking);
    document.getElementById("view-leaderboard-btn").addEventListener("click", showLeaderboard);
    document.getElementById("logout-btn").addEventListener("click", handleLogout);
    document.getElementById("game-back-btn").addEventListener("click", confirmQuitGame);
    document.getElementById("leaderboard-back-btn").addEventListener("click", backToMainMenu);
    document.getElementById("return-to-menu-btn").addEventListener("click", backToMainMenu);
    
    // Game controls
    document.getElementById("replay-note-btn").addEventListener("click", replayCurrentNote);
    
    // Add event listeners to note buttons
    const noteButtons = document.querySelectorAll(".note-btn");
    noteButtons.forEach(btn => {
        btn.addEventListener("click", () => handleNoteGuess(btn.getAttribute("data-note")));
    });
    
    // Add server info to the login screen
    const serverInfo = document.createElement('div');
    serverInfo.className = 'mt-4 text-center text-sm text-gray-500 dark:text-gray-400';
    serverInfo.textContent = `Connected to: ${API_URL}`;
    document.getElementById('login-screen').appendChild(serverInfo);
    
    // Connect to Socket.io server
    connectSocket();
    
    // Show login screen
    showScreen("login-screen");
}

// The rest of the client-side code remains the same as before
// [Rest of the app.js file from the previous version]

// Utility function to show notifications (custom implementation)
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = 'fixed bottom-4 right-4 p-4 rounded-lg shadow-lg z-50 animate-fadeIn';
    
    // Set color based on type
    if (type === 'error') {
        notification.classList.add('bg-danger', 'text-white');
    } else if (type === 'success') {
        notification.classList.add('bg-success', 'text-white');
    } else if (type === 'warning') {
        notification.classList.add('bg-accent', 'text-gray-900');
    } else {
        notification.classList.add('bg-primary', 'text-white');
    }
    
    notification.textContent = message;
    
    // Add to document
    document.body.appendChild(notification);
    
    // Remove after timeout
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transition = 'opacity 0.5s';
        
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 500);
    }, 4000);
}

// Initialize the app when the page loads
window.addEventListener("load", () => {
    // Small delay to allow the page to render first
    setTimeout(initApp, 500);
});