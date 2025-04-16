import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import { ChatGPTAPI } from 'chatgpt';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import bodyParser from 'body-parser';

dotenv.config();
const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = 'dinurba123';
const WHATSAPP_API_URL = 'https://graph.facebook.com/v17.0';
const PHONE_NUMBER_ID = '559929630545964';
const CHATGPT_MODEL = 'gpt-4';

let db;
(async () => {
  db = await open({
    filename: './conversaciones.db',
    driver: sqlite3.Database,
  });
  await db.run(`CREATE TABLE IF NOT EXISTS mensajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT,
    mensaje TEXT,
    rol TEXT,
    fecha DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
})();

const chatgpt = new ChatGPTAPI({ apiKey: process.env.OPENAI_API_KEY });

async function obtenerHistorial(numero) {
  const mensajes = await db.all(
    'SELECT rol, mensaje FROM mensajes WHERE numero = ? AND fecha >= datetime("now", "-6 months") ORDER BY fecha DESC LIMIT 30',
    [numero]
  );
  return mensajes.reverse();
}

async function guardarMensaje(numero, mensaje, rol) {
  await db.run('INSERT INTO mensajes (numero, mensaje, rol) VALUES (?, ?, ?)', [numero, mensaje, rol]);
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  const cambios = entry?.changes?.[0]?.value;
  const mensaje = cambios?.messages?.[0];

  if (mensaje && mensaje.type === 'text') {
    const numero = mensaje.from;
    const texto = mensaje.text.body;

    await guardarMensaje(numero, texto, 'user');
    const historial = await obtenerHistorial(numero);

    const respuestaIA = await chatgpt.sendMessage(texto, {
      messages: historial.map((m) => ({ role: m.rol, content: m.mensaje })),
      systemMessage: 'Responde solo preguntas relacionadas con los servicios de Dinurba. No hables de temas generales. Las respuestas deben ser claras y útiles para clientes reales.',
      model: CHATGPT_MODEL,
    });

    const respuesta = '🤖 ' + respuestaIA.text;
    await guardarMensaje(numero, respuesta, 'assistant');

    await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: numero,
        text: { body: respuesta },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));
