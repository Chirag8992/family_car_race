require('dotenv').config({ path: '../.env' });

const helpers = require('../utils/helpers');
const groupService = require('../services/group.service');
const gameService = require('../services/game.service');
const { redisClient } = require('../config/redis');
const db = require('../config/mysql');

const raceId = '673a6613-a52e-46f8-a240-0510e7a011cf';
const raceWeekStart = '2020-05-01';
const groupingDate = '2026-01-05';

(async () => {
  const groups = await groupService.computeDay1Groups(
    raceId,
    raceWeekStart,
    groupingDate,
    db,
    redisClient
  );

  console.log('Groups:', JSON.stringify(groups, null, 2));

  const allFamilies = [
    ...groups.group_1,
    ...groups.group_2,
    ...groups.group_3
  ];

  await groupService.writeGroupsToRedis(raceId, 1, groups, redisClient);
  await groupService.populateParticipantsSet(raceId, allFamilies, db, redisClient);
  await gameService.updateGameStatus(raceId, 'day1_pending', db, redisClient);

  console.log('Done');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});