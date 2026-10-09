// Local server: npm start, then open http://localhost:3000
const app = require('./app');
const port = process.env.PORT || process.argv[2] || 3000;
app.listen(port, () => console.log(`Aangan Studio front desk on http://localhost:${port}`));
