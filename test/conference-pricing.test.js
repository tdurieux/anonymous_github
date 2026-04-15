const { expect } = require("chai");

/**
 * Tests for Conference.toJSON() price calculation logic.
 *
 * Replicates the pricing algorithm from src/core/Conference.ts to test
 * the math in isolation without needing MongoDB.
 */

// ---------------------------------------------------------------------------
// Replicated price calculation from Conference.toJSON()
// ---------------------------------------------------------------------------

function calculatePrice(plan, repositories, endDate) {
  const pricePerHourPerRepo = plan.pricePerRepository / 30;
  let price = 0;
  const today = new Date() > endDate ? endDate : new Date();

  repositories.forEach((r) => {
    const removeDate =
      r.removeDate && r.removeDate < today ? r.removeDate : today;
    price +=
      (Math.max(removeDate.getTime() - r.addDate.getTime(), 0) /
        1000 /
        60 /
        60 /
        24) *
      pricePerHourPerRepo;
  });
  return price;
}

function countActiveRepos(repositories) {
  return repositories.filter((r) => !r.removeDate).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conference price calculation", function () {
  const DAY_MS = 24 * 60 * 60 * 1000;

  describe("basic pricing", function () {
    it("returns 0 for no repositories", function () {
      const price = calculatePrice(
        { pricePerRepository: 3 },
        [],
        new Date(Date.now() + 30 * DAY_MS)
      );
      expect(price).to.equal(0);
    });

    it("returns 0 for free plan", function () {
      const addDate = new Date(Date.now() - 10 * DAY_MS);
      const price = calculatePrice(
        { pricePerRepository: 0 },
        [{ addDate }],
        new Date(Date.now() + 30 * DAY_MS)
      );
      expect(price).to.equal(0);
    });

    it("calculates price for one repo over 10 days", function () {
      const now = new Date();
      const addDate = new Date(now.getTime() - 10 * DAY_MS);
      const endDate = new Date(now.getTime() + 20 * DAY_MS);
      const price = calculatePrice(
        { pricePerRepository: 3 },
        [{ addDate }],
        endDate
      );
      // pricePerHourPerRepo = 3/30 = 0.1 per day
      // duration ≈ 10 days
      // price ≈ 10 * 0.1 = 1.0
      expect(price).to.be.closeTo(1.0, 0.01);
    });

    it("calculates price for multiple repos", function () {
      const now = new Date();
      const addDate1 = new Date(now.getTime() - 10 * DAY_MS);
      const addDate2 = new Date(now.getTime() - 5 * DAY_MS);
      const endDate = new Date(now.getTime() + 20 * DAY_MS);
      const price = calculatePrice(
        { pricePerRepository: 3 },
        [{ addDate: addDate1 }, { addDate: addDate2 }],
        endDate
      );
      // repo1: 10 days * 0.1 = 1.0
      // repo2: 5 days * 0.1 = 0.5
      // total ≈ 1.5
      expect(price).to.be.closeTo(1.5, 0.01);
    });
  });

  describe("removed repositories", function () {
    it("uses removeDate as end for removed repos", function () {
      const now = new Date();
      const addDate = new Date(now.getTime() - 10 * DAY_MS);
      const removeDate = new Date(now.getTime() - 5 * DAY_MS);
      const endDate = new Date(now.getTime() + 20 * DAY_MS);
      const price = calculatePrice(
        { pricePerRepository: 3 },
        [{ addDate, removeDate }],
        endDate
      );
      // Only charged for 5 days (add to remove), not 10
      // 5 * 0.1 = 0.5
      expect(price).to.be.closeTo(0.5, 0.01);
    });

    it("uses today if removeDate is in the future", function () {
      const now = new Date();
      const addDate = new Date(now.getTime() - 10 * DAY_MS);
      const removeDate = new Date(now.getTime() + 5 * DAY_MS); // future
      const endDate = new Date(now.getTime() + 20 * DAY_MS);
      const price = calculatePrice(
        { pricePerRepository: 3 },
        [{ addDate, removeDate }],
        endDate
      );
      // removeDate is in the future, so today is used instead
      // ≈ 10 days * 0.1 = 1.0
      expect(price).to.be.closeTo(1.0, 0.01);
    });
  });

  describe("expired conference", function () {
    it("caps at endDate when conference is expired", function () {
      const endDate = new Date(Date.now() - 5 * DAY_MS); // 5 days ago
      const addDate = new Date(endDate.getTime() - 10 * DAY_MS); // 15 days ago
      const price = calculatePrice(
        { pricePerRepository: 3 },
        [{ addDate }],
        endDate
      );
      // Conference ended 5 days ago, repo was added 10 days before that
      // Only charged for 10 days (add to end)
      // 10 * 0.1 = 1.0
      expect(price).to.be.closeTo(1.0, 0.01);
    });
  });

  describe("edge cases", function () {
    it("handles zero-duration repository (add and remove same time)", function () {
      const now = new Date();
      const addDate = new Date(now.getTime() - 5 * DAY_MS);
      const removeDate = addDate; // same time
      const endDate = new Date(now.getTime() + 20 * DAY_MS);
      const price = calculatePrice(
        { pricePerRepository: 3 },
        [{ addDate, removeDate }],
        endDate
      );
      expect(price).to.equal(0);
    });

    it("handles removeDate before addDate via Math.max", function () {
      const now = new Date();
      const addDate = new Date(now.getTime() - 5 * DAY_MS);
      const removeDate = new Date(now.getTime() - 10 * DAY_MS); // before addDate
      const endDate = new Date(now.getTime() + 20 * DAY_MS);
      const price = calculatePrice(
        { pricePerRepository: 3 },
        [{ addDate, removeDate }],
        endDate
      );
      // Math.max ensures negative duration becomes 0
      expect(price).to.equal(0);
    });
  });
});

describe("Conference active repository count", function () {
  it("counts repos without removeDate", function () {
    const repos = [
      { addDate: new Date() },
      { addDate: new Date(), removeDate: new Date() },
      { addDate: new Date() },
    ];
    expect(countActiveRepos(repos)).to.equal(2);
  });

  it("returns 0 when all repos are removed", function () {
    const repos = [
      { addDate: new Date(), removeDate: new Date() },
      { addDate: new Date(), removeDate: new Date() },
    ];
    expect(countActiveRepos(repos)).to.equal(0);
  });

  it("returns 0 for empty list", function () {
    expect(countActiveRepos([])).to.equal(0);
  });

  it("counts all repos when none are removed", function () {
    const repos = [
      { addDate: new Date() },
      { addDate: new Date() },
      { addDate: new Date() },
    ];
    expect(countActiveRepos(repos)).to.equal(3);
  });
});
