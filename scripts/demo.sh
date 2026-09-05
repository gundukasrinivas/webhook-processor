#!/bin/bash
# Demo scenarios for the Reliable Webhook Processor
# Usage: bash scripts/demo.sh
# Requires: curl, jq (optional)

API="http://localhost:3001"

echo "============================================"
echo "  Reliable Webhook Processor — Demo"
echo "============================================"
echo ""

# -----------------------------------------------
# 1. Duplicate event
# -----------------------------------------------
echo "--- Scenario 1: Duplicate Event ---"
echo "Sending the same event 5 times (including concurrently)..."

for i in 1 2 3 4 5; do
  curl -s -X POST "$API/webhooks" \
    -H "Content-Type: application/json" \
    -d '{"eventId":"evt_dup_001","type":"order.created","data":{"orderId":"ORD-DUP","customerId":"CUS-1"}}' &
done
wait
echo ""
echo "Check: processed_orders should have exactly 1 row for evt_dup_001"
sleep 3
curl -s "$API/api/events/evt_dup_001" | python3 -m json.tool 2>/dev/null || curl -s "$API/api/events/evt_dup_001"
echo ""
echo ""

# -----------------------------------------------
# 2. Temporary failure
# -----------------------------------------------
echo "--- Scenario 2: Temporary Failure ---"
echo "Sending event that fails first 2 attempts, then succeeds..."

curl -s -X POST "$API/webhooks" \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_temp_fail","type":"order.created","data":{"orderId":"ORD-TEMP","customerId":"CUS-2","simulate":"fail_then_succeed:2"}}'
echo ""
echo "Wait ~15s for retries..."
sleep 15
echo "Attempt history:"
curl -s "$API/api/events/evt_temp_fail" | python3 -m json.tool 2>/dev/null || curl -s "$API/api/events/evt_temp_fail"
echo ""
echo ""

# -----------------------------------------------
# 3. Permanent failure
# -----------------------------------------------
echo "--- Scenario 3: Permanent Failure ---"
echo "Sending event that always fails..."

curl -s -X POST "$API/webhooks" \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_always_fail","type":"order.created","data":{"orderId":"ORD-PERM","customerId":"CUS-3","simulate":"always_fail"}}'
echo ""
echo "Wait ~60s for all retries to exhaust..."
sleep 60
echo "Event should be in 'failed' state:"
curl -s "$API/api/events/evt_always_fail" | python3 -m json.tool 2>/dev/null || curl -s "$API/api/events/evt_always_fail"
echo ""
echo ""

# -----------------------------------------------
# 4. Parallel processing
# -----------------------------------------------
echo "--- Scenario 4: Parallel Processing ---"
echo "Sending 4 slow events (5s each)..."

for i in 1 2 3 4; do
  curl -s -X POST "$API/webhooks" \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"evt_slow_$i\",\"type\":\"order.created\",\"data\":{\"orderId\":\"ORD-SLOW-$i\",\"customerId\":\"CUS-4\",\"simulate\":\"slow:5\"}}" &
done
wait
echo ""
echo "Workers should process these concurrently. Wait 10s..."
sleep 10
echo "Stats:"
curl -s "$API/api/stats" | python3 -m json.tool 2>/dev/null || curl -s "$API/api/stats"
echo ""
echo ""

# -----------------------------------------------
# 5. Worker crash (manual)
# -----------------------------------------------
echo "--- Scenario 5: Worker Crash ---"
echo "Send a slow event (20s), then kill a worker to test crash recovery."
echo "Steps:"
echo "  1. Run: curl -X POST $API/webhooks -H 'Content-Type: application/json' -d '{\"eventId\":\"evt_crash\",\"type\":\"order.created\",\"data\":{\"orderId\":\"ORD-CRASH\",\"simulate\":\"slow:20\"}}'"
echo "  2. Run: docker compose kill worker1"
echo "  3. Wait 30s for lease timeout"
echo "  4. worker2 should recover the event"
echo "  5. Check: curl $API/api/events/evt_crash"
echo ""

# -----------------------------------------------
# 6. Burst — 500 events
# -----------------------------------------------
echo "--- Scenario 6: Burst (500 events) ---"
echo "Sending 500 events..."

for i in $(seq 1 500); do
  curl -s -X POST "$API/webhooks" \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"evt_burst_$i\",\"type\":\"order.created\",\"data\":{\"orderId\":\"ORD-BURST-$i\",\"customerId\":\"CUS-BURST\"}}" &

  # Batch in groups of 50 to avoid overwhelming curl
  if [ $((i % 50)) -eq 0 ]; then
    wait
    echo "  Sent $i / 500"
  fi
done
wait
echo "  Sent 500 / 500"
echo ""
echo "Wait for processing..."
sleep 30
echo "Final stats:"
curl -s "$API/api/stats" | python3 -m json.tool 2>/dev/null || curl -s "$API/api/stats"
echo ""
echo "Done!"
