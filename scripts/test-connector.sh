#!/usr/bin/env bash
# Prueba end-to-end del conector (requiere backend en :4000)
set -e
BASE="${CHAT_CONNECTOR_URL:-http://localhost:4000}"
TICKET_ID="${TEST_TICKET_ID:-TEST-001}"
CUSTOMER_ID="${TEST_CUSTOMER_ID:-user_test_001}"

echo "=== Health ==="
curl -s "$BASE/api/integrations/health" | head -c 200
echo -e "\n"

echo "=== Link conversación ==="
curl -s -X POST "$BASE/api/integrations/conversations/link" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: maracaibo_secret_key_2026" \
  -d "{\"ticketId\":\"$TICKET_ID\",\"customerId\":\"$CUSTOMER_ID\",\"customerName\":\"Usuario Prueba\"}"
echo -e "\n"

echo "=== Mensaje desde Sistema de Tickets → Maracaibo ==="
curl -s -X POST "$BASE/api/integrations/messages" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: tickets_secret_key_2026" \
  -d "{\"ticketId\":\"$TICKET_ID\",\"content\":\"Mensaje de prueba del sistema de tickets $(date +%H:%M:%S)\",\"agentName\":\"Agente Tickets\"}"
echo -e "\n"

echo "=== Historial ==="
curl -s "$BASE/api/integrations/conversations/$TICKET_ID/messages" \
  -H "X-Api-Key: tickets_secret_key_2026"
echo -e "\n"
echo "✅ Si tienes maracaibo.html abierto con data-ticket-id=$TICKET_ID, deberías ver el mensaje en el chat."
