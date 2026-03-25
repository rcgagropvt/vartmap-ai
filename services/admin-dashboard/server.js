const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.static(path.join(__dirname)));

// Spin wheel public page
app.get('/spin/:wheelId', (req, res) => {
    res.sendFile(path.join(__dirname, 'spin.html'));
});

// Prize history public page
app.get('/my-prizes', (req, res) => {
    res.sendFile(path.join(__dirname, 'prizes.html'));
});

app.get('/my-loyalty', (req, res) => {
    res.sendFile(path.join(__dirname, 'loyalty.html'));
});


app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Admin Dashboard running on port ${PORT}`);
});
