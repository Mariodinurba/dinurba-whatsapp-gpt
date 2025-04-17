// servidor.js actualizado para que funcione con Meta + ChatGPT

const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { ChatGPTAPI } = require('chatgpt');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const chatgpt = new ChatGPTAPI({ apiKey: OPENAI_API_KEY });

app.use(bodyParser.json());

// Ruta para recibir mensajes de WhatsApp
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;

    if (messages && messages[0]) {
      const phoneNumber = messages[0].from;
      const messageText = messages[0].text?.body;

      console.log(“📲 Mensaje recibido de ” + phoneNumber + “: ” + messageText);

      // Consulta a ChatGPT
      const respuesta = await chatgpt.sendMessage(messageText, {
        systemMessage: "Eres un asistente de Dinurba. Responde con claridad y solo temas relacionados al negocio."
      });

      await fetch(`https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phoneNumber,
          text: { body: `🤖 ${respuesta.text}` }
        })
      });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Error en webhook:', err);
    res.sendStatus(500);
  }
});

// Verificación del webhook de Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
