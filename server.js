const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Sirve cualquier archivo estático de esta carpeta (css, imágenes, etc. si agregás más adelante)
app.use(express.static(__dirname));

// Ruta principal: abre directamente el casino
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'casino-negro.html'));
});

app.listen(PORT, () => {
  console.log('Casino Negro corriendo en el puerto ' + PORT);
});
