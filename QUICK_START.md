# 🚀 Quick Start Guide

## One-Command Setup
```bash
cd stock-tracker
npm install && npm start
```

## Project Structure
```
stock-tracker/
├── server.js           # Main backend
├── data.json           # Stored data
├── package.json        # Dependencies
├── public/             # Frontend files
├── CLAUDE_NOTES.md     # Chat history & code library (THIS FILE)
├── QUICK_START.md      # This guide
├── PROJECT_STATUS.md   # Project progress
└── README.md           # Original docs
```

## Key Commands
```bash
npm start              # Start server
npm install            # Install dependencies
npm stop               # Stop server
npm run dev            # Development mode (if available)
```

## Environment Setup
- Copy `.env.example` to `.env`
- Add your API keys there
- Never commit `.env` to git

## Need Help?
1. Check `CLAUDE_NOTES.md` for past solutions
2. Look at `PROJECT_STATUS.md` for context
3. Run `git log` to see what was changed last

## Ask Claude
When you ask Claude to continue:
> "Continue my stock and crypto tracker. Check CLAUDE_NOTES.md for context."

This way Claude can see all your previous work in one place!
