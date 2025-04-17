const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Cargar archivo de conocimiento
const conocimiento = JSON.parse(fs.readFileSync('./conocimiento_dinurba.json', 'utf8'));

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObject = value?.messages?.[0];

    if (messageObject) {
      const phoneNumber = messageObject.from;
      const messageText = messageObject.text?.body;

      console.log("📩 Mensaje recibido de " + phoneNumber + ": " + messageText);

      try {
        const prompt = `
${conocimiento.contexto_negocio}
Instrucciones:
${conocimiento.instrucciones_respuesta.map(i => '- ' + i).join('\n')}

Respuestas base:
${Object.entries(conocimiento.respuestas_base)
  .map(([k, v]) => `${k}: "${v}"`)
  .join('\n')}

Mensaje del cliente: "${messageText}"
`;

        const respuestaIA = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: "gpt-4",
            messages: [
              { role: "system", content: "Eres un asistente de atención al cliente." },
              { role: "user", content: prompt }
            ]
          },
          {
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const respuesta = respuestaIA.data.choices[0].message.content;

        await axios.post(
          `https://graph.facebook.com/v18.0/${value.metadata.phone_number_id}/messages`,
          {
            messaging_product: "whatsapp",
            to: phoneNumber,
            text: {
              body: "🤖 " + respuesta
            }
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log("✅ Respuesta enviada a WhatsApp.");
      } catch (error) {
        console.error("❌ Error enviando mensaje a WhatsApp o generando respuesta de IA:", error.response?.data || error.message);
      }
    }

    return res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verificado.");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
