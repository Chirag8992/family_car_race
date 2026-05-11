require('dotenv').config();
const { io } = require('socket.io-client');

const TOKEN      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySUQiOjEyNTAwLCJtZW1iZXJJZCI6MTI1MDAsImZhbWlseUlkIjo4NSwicm9sZSI6InVzZXIiLCJ0eXBlIjoiYWNjZXNzIiwiaWF0IjoxNzc3NDAxMDUxLCJleHAiOjE3Nzc0ODc0NTF9.7MHVemMFybah1S6HxpVOEuF9HaBa2rLj_SutozugLRI';
const RACE_ID    = '4b2600de-3768-4c38-b2b4-15a6cd42902e';
const MEMBER_ID  = '12500';

const socket = io('http://localhost:3000', { transports: ['websocket'] });

socket.on('connect', () => {
  console.log('✓ Connected:', socket.id);
  socket.emit('join_room', { raceId: RACE_ID, dayNumber: 1, groupNumber: 1, memberId: MEMBER_ID, token: TOKEN });
});
socket.on('joined',          (d) => console.log('✓ joined:', JSON.stringify(d, null, 2)));
socket.on('crystal_ready',   (d) => console.log('✓ crystal_ready:', d));
socket.on('crystal_earned',  (d) => console.log('✓ crystal_earned:', d));
socket.on('egg_hit',         (d) => console.log('✓ egg_hit:', d));
socket.on('wiper_used',      (d) => console.log('✓ wiper_used:', d));
socket.on('fuel_submitted',  (d) => console.log('✓ fuel_submitted:', d));
socket.on('leaderboard_update',(d)=> console.log('✓ leaderboard_update:', d));
socket.on('error',           (d) => console.error('✗ error:', d.message));
socket.on('disconnect',      (r) => console.log('Disconnected:', r));