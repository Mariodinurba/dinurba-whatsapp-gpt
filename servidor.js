// servidor.js
import express from 'express';
import bodyParser from 'body-parser';
import { ChatGPTAPI } from 'chatgpt';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

const openai = new ChatGPTAPI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get('/', (req, res) => {
  res.send('🤖 Dinurba WhatsApp Bot está activo.');
});

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messageData = changes?.value?.messages?.[0];

    if (!messageData) {
      return res.sendStatus(200);
    }

    const from = messageData.from;
    const userMessage = messageData.text?.body;

    console.log(`📩 Mensaje recibido de ${from}: ${userMessage}`);

    // Generar respuesta con IA
    const respuestaIA = await openai.sendMessage(
      `Eres el asistente virtual de la empresa Dinurba. Tu trabajo es responder SOLO sobre los servicios de la empresa, trámites, cotizaciones, citas y dudas de clientes. NO respondas preguntas generales que no estén relacionadas con Dinurba. El cliente escribió: ${userMessage}`
    );

    await enviarMensajeWhatsApp(from, respuestaIA.text);

    return res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en /webhook:', error);
    return res.sendStatus(500);
  }
});

async function enviarMensajeWhatsApp(to, text) {
  const url = 'https://graph.facebook.com/v17.0/' + process.env.PHONE_NUMBER_ID + '/messages';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: `🤖 ${text}` }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('❌ Error enviando mensaje a WhatsApp:', error);
  }
}

app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${port}`);
});
