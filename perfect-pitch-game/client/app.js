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
const API_URL = 'http://localhost:3000';
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
    });
    
    socket.on('authenticated', (data) => {
        if (data.success) {
            console.log('Socket authenticated');
        } else {
            console.error('Socket authentication failed:', data.error);
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
    
    // Connect to Socket.io server
    connectSocket();
    
    // Show login screen
    showScreen("login-screen");
}

// Screen navigation functions
function showScreen(screenId) {
    // Hide all screens
    document.getElementById("loading-screen").classList.add("hidden");
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("main-menu").classList.add("hidden");
    document.getElementById("game-screen").classList.add("hidden");
    document.getElementById("results-screen").classList.add("hidden");
    document.getElementById("leaderboard-screen").classList.add("hidden");
    
    // Show requested screen
    document.getElementById(screenId).classList.remove("hidden");
    
    // Specific actions for certain screens
    if (screenId === "main-menu") {
        updateUserInfo();
        fetchUserStats();
        fetchLeaderboardPreview();
    } else if (screenId === "leaderboard-screen") {
        fetchFullLeaderboard();
    }
}

// Login form handling
function showLoginForm() {
    document.getElementById("login-tab").classList.add("border-primary");
    document.getElementById("login-tab").classList.remove("text-gray-500", "dark:text-gray-400", "border-gray-300", "dark:border-gray-700");
    
    document.getElementById("register-tab").classList.remove("border-primary");
    document.getElementById("register-tab").classList.add("text-gray-500", "dark:text-gray-400", "border-gray-300", "dark:border-gray-700");
    
    document.getElementById("login-form").classList.remove("hidden");
    document.getElementById("register-form").classList.add("hidden");
    document.getElementById("login-error").classList.add("hidden");
}

function showRegisterForm() {
    document.getElementById("register-tab").classList.add("border-primary");
    document.getElementById("register-tab").classList.remove("text-gray-500", "dark:text-gray-400", "border-gray-300", "dark:border-gray-700");
    
    document.getElementById("login-tab").classList.remove("border-primary");
    document.getElementById("login-tab").classList.add("text-gray-500", "dark:text-gray-400", "border-gray-300", "dark:border-gray-700");
    
    document.getElementById("register-form").classList.remove("hidden");
    document.getElementById("login-form").classList.add("hidden");
    document.getElementById("register-error").classList.add("hidden");
}

async function handleLogin() {
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    
    if (!username || !password) {
        showLoginError("Please enter both username and password");
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentUser = data.user;
            
            // Authenticate socket connection
            authenticateSocket();
            
            showScreen("main-menu");
        } else {
            showLoginError(data.error);
        }
    } catch (error) {
        console.error('Login error:', error);
        showLoginError("Server connection error. Please try again.");
    }
}

async function handleRegister() {
    const username = document.getElementById("register-username").value.trim();
    const password = document.getElementById("register-password").value;
    const confirm = document.getElementById("register-confirm").value;
    
    if (!username || !password) {
        showRegisterError("Please enter both username and password");
        return;
    }
    
    if (password !== confirm) {
        showRegisterError("Passwords do not match");
        return;
    }
    
    if (username.length < 3) {
        showRegisterError("Username must be at least 3 characters");
        return;
    }
    
    if (password.length < 4) {
        showRegisterError("Password must be at least 4 characters");
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentUser = data.user;
            
            // Authenticate socket connection
            authenticateSocket();
            
            showScreen("main-menu");
        } else {
            showRegisterError(data.error);
        }
    } catch (error) {
        console.error('Registration error:', error);
        showRegisterError("Server connection error. Please try again.");
    }
}

function showLoginError(message) {
    const errorEl = document.getElementById("login-error");
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
}

function showRegisterError(message) {
    const errorEl = document.getElementById("register-error");
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
}

function handleLogout() {
    currentUser = null;
    
    // Disconnect socket
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    
    showScreen("login-screen");
    showLoginForm();
    document.getElementById("login-username").value = "";
    document.getElementById("login-password").value = "";
}

// User and stats functions
function updateUserInfo() {
    if (!currentUser) return;
    
    document.getElementById("user-name").textContent = currentUser.username;
    document.getElementById("user-elo").textContent = `ELO: ${currentUser.elo}`;
    
    // Update user badge
    const rank = getRankFromElo(currentUser.elo);
    const userBadge = document.getElementById("user-badge");
    userBadge.className = "rank-badge mr-3";
    userBadge.classList.add(rank.class);
    userBadge.setAttribute("title", rank.name);
    userBadge.textContent = rank.name.charAt(0);
}

async function fetchUserStats() {
    if (!currentUser) return;
    
    try {
        const response = await fetch(`${API_URL}/api/user/${currentUser.id}`);
        const data = await response.json();
        
        if (data.success) {
            const user = data.user;
            
            // Calculate stats
            const winRate = user.matchesPlayed > 0 
                ? Math.round((user.matchesWon / user.matchesPlayed) * 100) 
                : 0;
            
            const accuracy = user.totalRounds > 0 
                ? Math.round((user.roundsWon / user.totalRounds) * 100) 
                : 0;
            
            document.getElementById("stats-matches").textContent = user.matchesPlayed;
            document.getElementById("stats-winrate").textContent = `${winRate}%`;
            document.getElementById("stats-rank").textContent = getRankNameFromElo(user.elo);
            document.getElementById("stats-accuracy").textContent = `${accuracy}%`;
        }
    } catch (error) {
        console.error('Error fetching user stats:', error);
    }
}

async function fetchLeaderboardPreview() {
    try {
        const response = await fetch(`${API_URL}/api/leaderboard`);
        const data = await response.json();
        
        if (data.success) {
            const leaderboard = data.leaderboard.slice(0, 3);
            const previewEl = document.getElementById("leaderboard-preview");
            
            if (leaderboard.length === 0) {
                previewEl.innerHTML = "<p class='text-center text-gray-500 dark:text-gray-400'>No ranked players yet</p>";
                return;
            }
            
            let html = "";
            leaderboard.forEach(user => {
                const rank = getRankFromElo(user.elo);
                html += `
                <div class="flex items-center justify-between py-1">
                    <div class="flex items-center">
                        <div class="rank-badge w-8 h-8 mr-2 ${rank.class}" title="${rank.name}">${rank.name.charAt(0)}</div>
                        <span class="font-semibold">${user.username}</span>
                    </div>
                    <span>${user.elo}</span>
                </div>
                `;
            });
            
            previewEl.innerHTML = html;
        }
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
    }
}

async function fetchFullLeaderboard() {
    try {
        const response = await fetch(`${API_URL}/api/leaderboard`);
        const data = await response.json();
        
        if (data.success) {
            const leaderboard = data.leaderboard;
            const tbody = document.getElementById("leaderboard-body");
            
            if (leaderboard.length === 0) {
                tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="p-4 text-center text-gray-500 dark:text-gray-400">No ranked players yet</td>
                </tr>
                `;
                return;
            }
            
            let html = "";
            leaderboard.forEach(user => {
                const rank = getRankFromElo(user.elo);
                const isCurrentUser = currentUser && user.id === currentUser.id;
                const rowClass = isCurrentUser ? "bg-primary bg-opacity-10" : "";
                
                html += `
                <tr class="${rowClass}">
                    <td class="p-3">${user.rank}</td>
                    <td class="p-3">
                        <div class="flex items-center">
                            <div class="rank-badge w-8 h-8 mr-2 ${rank.class}" title="${rank.name}">${rank.name.charAt(0)}</div>
                            <span class="font-semibold">${user.username}</span>
                        </div>
                    </td>
                    <td class="p-3">${user.elo}</td>
                    <td class="p-3">${user.matchesPlayed}</td>
                    <td class="p-3">${user.winRate}%</td>
                </tr>
                `;
            });
            
            tbody.innerHTML = html;
        }
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
    }
}

function showLeaderboard() {
    showScreen("leaderboard-screen");
}

function backToMainMenu() {
    showScreen("main-menu");
}

// Get rank information based on ELO
function getRankFromElo(elo) {
    for (let i = RANKS.length - 1; i >= 0; i--) {
        if (elo >= RANKS[i].min) {
            return RANKS[i];
        }
    }
    return RANKS[0];
}

function getRankNameFromElo(elo) {
    return getRankFromElo(elo).name;
}

// Matchmaking functions
function joinMatchmaking() {
    if (!socket || !currentUser) {
        showNotification("Connection error. Please log in again.", "error");
        return;
    }
    
    if (inQueue) return;
    
    socket.emit('join_queue');
    inQueue = true;
    queueStartTime = Date.now();
    
    // Start queue timer update
    updateQueueTimer();
    
    // Show queue status UI
    updateQueueUI(true);
}

function cancelMatchmaking() {
    if (!socket || !inQueue) return;
    
    socket.emit('leave_queue');
    inQueue = false;
    
    // Hide queue status UI
    updateQueueUI(false);
}

function updateQueueUI(inQueue) {
    const playButton = document.getElementById('play-match-btn');
    const queueStatus = document.getElementById('queue-status');
    
    if (inQueue) {
        playButton.classList.add('hidden');
        queueStatus.classList.remove('hidden');
    } else {
        playButton.classList.remove('hidden');
        queueStatus.classList.add('hidden');
    }
}

function updateQueueTimer() {
    if (!inQueue) return;
    
    const queueTime = document.getElementById('queue-time');
    const elapsedSeconds = Math.floor((Date.now() - queueStartTime) / 1000);
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    
    queueTime.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    requestAnimationFrame(updateQueueTimer);
}

// Game functions
function startGame() {
    // Reset game state
    updateQueueUI(false);
    
    // Update game UI with player information
    document.getElementById("current-round").textContent = activeGame.round;
    document.getElementById("player-score").textContent = "0";
    document.getElementById("opponent-score").textContent = "0";
    
    // Player info
    document.getElementById("player-name").textContent = currentUser.username;
    document.getElementById("player-elo").textContent = `ELO: ${currentUser.elo}`;
    
    // Opponent info
    const opponent = activeGame.isPlayer1 ? activeGame.player2 : activeGame.player1;
    document.getElementById("opponent-name").textContent = opponent.username;
    document.getElementById("opponent-elo").textContent = `ELO: ${opponent.elo}`;
    
    // Setup player badges
    const playerRank = getRankFromElo(currentUser.elo);
    const playerBadge = document.getElementById("player-badge");
    playerBadge.className = "rank-badge mr-3";
    playerBadge.classList.add(playerRank.class);
    playerBadge.setAttribute("title", playerRank.name);
    playerBadge.textContent = playerRank.name.charAt(0);
    
    const opponentRank = getRankFromElo(opponent.elo);
    const opponentBadge = document.getElementById("opponent-badge");
    opponentBadge.className = "rank-badge mr-3";
    opponentBadge.classList.add(opponentRank.class);
    opponentBadge.setAttribute("title", opponentRank.name);
    opponentBadge.textContent = opponentRank.name.charAt(0);
    
    // Hide the note indicator
    document.getElementById("note-indicator").classList.add("hidden");
    
    // Reset timer bar
    document.getElementById("timer-bar").style.width = "100%";
    
    // Reset game status
    document.getElementById("game-status").textContent = "Get ready...";
    document.getElementById("game-status").className = "mb-6 text-center text-lg font-semibold text-primary";
    
    // Reset note button styles
    resetNoteButtons();
    
    // Switch to game screen
    showScreen("game-screen");
}

function startRound() {
    // Reset for new round
    document.getElementById("current-round").textContent = activeGame.round;
    document.getElementById("game-status").textContent = "Listen to the note and guess it first!";
    document.getElementById("game-status").className = "mb-6 text-center text-lg font-semibold text-primary";
    
    // Hide the note indicator
    document.getElementById("note-indicator").classList.add("hidden");
    
    // Reset timer bar
    document.getElementById("timer-bar").style.width = "100%";
    
    // Reset note buttons
    resetNoteButtons();
    
    // Enable all note buttons
    const noteButtons = document.querySelectorAll(".note-btn");
    noteButtons.forEach(btn => {
        btn.disabled = false;
        btn.classList.remove("disabled");
    });
    
    // Play the note
    playNote(activeGame.currentNote);
    
    // Start round timer
    startRoundTimer();
}

function handleNoteGuess(note) {
    if (!activeGame || !activeGame.currentNote) return;
    
    // Send guess to server
    socket.emit('guess', {
        gameId: activeGame.id,
        note: note
    });
}

function revealNote(note, winnerId) {
    // Disable all note buttons
    const noteButtons = document.querySelectorAll(".note-btn");
    noteButtons.forEach(btn => {
        btn.disabled = true;
        btn.classList.add("disabled");
    });
    
    // Highlight the correct note button
    noteButtons.forEach(btn => {
        if (btn.getAttribute("data-note") === note) {
            btn.classList.add("correct");
        }
    });
    
    // Show the note indicator
    document.getElementById("actual-note").textContent = note;
    
    // Set round result text
    const roundResult = document.getElementById("round-result");
    
    if (winnerId === null) {
        roundResult.textContent = "No one guessed in time!";
        roundResult.className = "text-sm text-primary";
    } else if (winnerId === currentUser.id) {
        roundResult.textContent = "You won this round!";
        roundResult.className = "text-sm text-success";
    } else {
        const opponentName = activeGame.isPlayer1 ? activeGame.player2.username : activeGame.player1.username;
        roundResult.textContent = `${opponentName} won this round!`;
        roundResult.className = "text-sm text-danger";
    }
    
    document.getElementById("note-indicator").classList.remove("hidden");
}

function startRoundTimer() {
    // Clear any existing timer
    clearRoundTimer();
    
    const startTime = Date.now();
    roundEndTime = startTime + ROUND_TIMEOUT;
    
    roundTimerInterval = setInterval(() => {
        const timeLeft = roundEndTime - Date.now();
        const percentage = Math.max(0, (timeLeft / ROUND_TIMEOUT) * 100);
        
        // Update timer bar
        document.getElementById("timer-bar").style.width = `${percentage}%`;
        
        // Change color based on time left
        const timerBar = document.getElementById("timer-bar");
        if (percentage > 60) {
            timerBar.className = "h-full bg-primary rounded-full";
        } else if (percentage > 30) {
            timerBar.className = "h-full bg-accent rounded-full";
        } else {
            timerBar.className = "h-full bg-danger rounded-full";
        }
        
        if (timeLeft <= 0) {
            clearRoundTimer();
        }
    }, 50);
}

function clearRoundTimer() {
    if (roundTimerInterval) {
        clearInterval(roundTimerInterval);
        roundTimerInterval = null;
    }
}

function showGameResults(data, isWinner, isTie) {
    // Set player info
    const playerData = activeGame.isPlayer1 ? data.player1 : data.player2;
    const opponentData = activeGame.isPlayer1 ? data.player2 : data.player1;
    
    // Update results screen with player information
    document.getElementById("result-player-name").textContent = currentUser.username;
    document.getElementById("result-player-score").textContent = playerData.score;
    
    document.getElementById("result-opponent-name").textContent = activeGame.isPlayer1 ? activeGame.player2.username : activeGame.player1.username;
    document.getElementById("result-opponent-score").textContent = opponentData.score;
    
    // Setup player badges
    const playerRank = getRankFromElo(currentUser.elo);
    const playerBadge = document.getElementById("result-player-badge");
    playerBadge.className = "rank-badge";
    playerBadge.classList.add(playerRank.class);
    playerBadge.setAttribute("title", playerRank.name);
    playerBadge.textContent = playerRank.name.charAt(0);
    
    const opponentElo = activeGame.isPlayer1 ? activeGame.player2.elo : activeGame.player1.elo;
    const opponentRank = getRankFromElo(opponentElo);
    const opponentBadge = document.getElementById("result-opponent-badge");
    opponentBadge.className = "rank-badge";
    opponentBadge.classList.add(opponentRank.class);
    opponentBadge.setAttribute("title", opponentRank.name);
    opponentBadge.textContent = opponentRank.name.charAt(0);
    
    // Display result message
    const matchResult = document.getElementById("match-result");
    const eloChange = document.getElementById("elo-change");
    
    if (isTie) {
        matchResult.textContent = "It's a tie!";
        matchResult.className = "text-xl font-bold text-primary";
        eloChange.textContent = "No ELO change";
        eloChange.className = "mt-2";
    } else if (isWinner) {
        matchResult.textContent = "You won the match!";
        matchResult.className = "text-xl font-bold text-success";
        eloChange.textContent = `ELO: +${playerData.eloChange}`;
        eloChange.className = "mt-2 text-success";
    } else {
        matchResult.textContent = "You lost the match!";
        matchResult.className = "text-xl font-bold text-danger";
        eloChange.textContent = `ELO: ${playerData.eloChange}`;
        eloChange.className = "mt-2 text-danger";
    }
    
    // Reset active game
    activeGame = null;
    
    // Show results screen
    showScreen("results-screen");
}

function confirmQuitGame() {
    if (!activeGame) {
        backToMainMenu();
        return;
    }
    
    if (confirm("Are you sure you want to quit this match? You will lose ELO points.")) {
        // Forfeit the game
        socket.emit('forfeit_game', {
            gameId: activeGame.id
        });
    }
}

function resetNoteButtons() {
    const noteButtons = document.querySelectorAll(".note-btn");
    noteButtons.forEach(btn => {
        btn.classList.remove("correct", "incorrect", "disabled");
        btn.disabled = false;
    });
}

function replayCurrentNote() {
    if (!activeGame || !activeGame.currentNote) return;
    
    // Request server to replay the note (to prevent cheating)
    socket.emit('replay_note', {
        gameId: activeGame.id
    });
}

function playNote(note) {
    if (!audioContext || !note) return;
    
    // Make sure the audio context is running
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    
    // Note frequencies (based on middle octave)
    const frequencies = {
        'C': 261.63,
        'C#': 277.18,
        'D': 293.66,
        'D#': 311.13,
        'E': 329.63,
        'F': 349.23,
        'F#': 369.99,
        'G': 392.00,
        'G#': 415.30,
        'A': 440.00,
        'A#': 466.16,
        'B': 493.88
    };
    
    // Create oscillator
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    // Set note parameters
    oscillator.type = 'sine';
    oscillator.frequency.value = frequencies[note];
    
    // Create envelope
    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.5, audioContext.currentTime + 0.1);
    gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.3);
    gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 1.5);
    
    // Connect nodes
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // Play the note
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 1.5);
}

// Utility function to show notifications
function showNotification(message, type = 'info') {
    // Simple alert for now, could be replaced with a custom notification UI
    alert(message);
}

// Initialize the app when the page loads
window.addEventListener("load", () => {
    // Small delay to allow the page to render first
    setTimeout(initApp, 500);
});