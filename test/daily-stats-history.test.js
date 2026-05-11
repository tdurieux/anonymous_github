require("ts-node/register/transpile-only");

const { expect } = require("chai");
const {
  mergeCurrentStatsIntoHistory,
} = require("../src/server/dailyStatsSnapshot");

describe("daily stats history", function () {
  const liveStats = {
    nbRepositories: 15,
    nbUsers: 7,
    nbPageViews: 120,
    nbPullRequests: 4,
  };

  it("replaces today's stored snapshot with live totals", function () {
    const rows = [
      {
        date: new Date("2026-05-10T00:00:00.000Z"),
        nbRepositories: 10,
        nbUsers: 5,
        nbPageViews: 100,
        nbPullRequests: 2,
      },
      {
        date: new Date("2026-05-11T00:05:00.000Z"),
        nbRepositories: 11,
        nbUsers: 5,
        nbPageViews: 101,
        nbPullRequests: 2,
      },
    ];

    const history = mergeCurrentStatsIntoHistory(
      rows,
      liveStats,
      new Date("2026-05-11T14:30:00.000Z")
    );

    expect(history).to.have.length(2);
    expect(history[1]).to.deep.include(liveStats);
    expect(history[1].date.toISOString()).to.equal("2026-05-11T00:00:00.000Z");
  });

  it("appends today's live totals when no snapshot exists", function () {
    const history = mergeCurrentStatsIntoHistory(
      [
        {
          date: new Date("2026-05-10T00:00:00.000Z"),
          nbRepositories: 10,
          nbUsers: 5,
          nbPageViews: 100,
          nbPullRequests: 2,
        },
      ],
      liveStats,
      new Date("2026-05-11T14:30:00.000Z")
    );

    expect(history).to.have.length(2);
    expect(history[1]).to.deep.include(liveStats);
    expect(history[1].date.toISOString()).to.equal("2026-05-11T00:00:00.000Z");
  });
});
