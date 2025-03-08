const mongoose = require('mongoose');

const MatchSchema = new mongoose.Schema({
  player1: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  player2: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  player1Score: {
    type: Number,
    required: true
  },
  player2Score: {
    type: Number,
    required: true
  },
  winner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  eloChange1: {
    type: Number,
    default: 0
  },
  eloChange2: {
    type: Number,
    default: 0
  },
  playedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Match', MatchSchema);