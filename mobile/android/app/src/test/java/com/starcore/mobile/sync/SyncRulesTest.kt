package com.starcore.mobile.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncRulesTest {
    private val mib = 1024L * 1024

    @Test
    fun chunksCoverTheFileFromTheOffset() {
        assertEquals(listOf(0L to 8 * mib, 8 * mib to 8 * mib, 16 * mib to 4 * mib), SyncRules.chunks(20 * mib, 0, 8 * mib))
        assertEquals(listOf(10 * mib to 8 * mib, 18 * mib to 2 * mib), SyncRules.chunks(20 * mib, 10 * mib, 8 * mib))
        assertEquals(listOf(0L to 1L), SyncRules.chunks(1, 0, 8 * mib))
        assertTrue(SyncRules.chunks(20 * mib, 20 * mib, 8 * mib).isEmpty())
        assertNull(SyncRules.nextChunk(5, -1, 2))
    }

    @Test
    fun theChunkSizeStaysWithinBounds() {
        assertEquals(SyncRules.DEFAULT_CHUNK, SyncRules.chunkSize(null))
        assertEquals(SyncRules.DEFAULT_CHUNK, SyncRules.chunkSize(0))
        assertEquals(mib, SyncRules.chunkSize(mib))
        assertEquals(SyncRules.MAX_CHUNK, SyncRules.chunkSize(1024 * mib))
    }

    @Test
    fun backoffDoublesAndIsCapped() {
        assertEquals(60_000L, SyncRules.backoffMillis(1))
        assertEquals(120_000L, SyncRules.backoffMillis(2))
        assertEquals(240_000L, SyncRules.backoffMillis(3))
        assertEquals(6 * 60 * 60_000L, SyncRules.backoffMillis(30))
    }

    @Test
    fun aFailedItemWaitsThenStopsUntilTryAgain() {
        assertEquals(1 to 1_060_000L, SyncRules.failure(0, 1_000_000, final = false))
        assertEquals(2 to 1_120_000L, SyncRules.failure(1, 1_000_000, final = false))
        assertEquals(SyncRules.MAX_ATTEMPTS to Long.MAX_VALUE, SyncRules.failure(SyncRules.MAX_ATTEMPTS - 1, 0, final = false))
        assertEquals(1 to Long.MAX_VALUE, SyncRules.failure(0, 0, final = true))
    }

    @Test
    fun aRunIsScheduledForTheSoonestRetry() {
        assertEquals(60_000L, SyncRules.laterDelay(1_060_000, 1_000_000))
        // came due during the run: soon, not at once
        assertEquals(SyncRules.MIN_LATER, SyncRules.laterDelay(990_000, 1_000_000))
        // waits for "Try again", or nothing failed
        assertNull(SyncRules.laterDelay(Long.MAX_VALUE, 1_000_000))
        assertNull(SyncRules.laterDelay(null, 1_000_000))
    }

    @Test
    fun anEditIsANewFile() {
        assertFalse(SyncRules.changed(10, 20, 3, 10, 20, 3))
        assertTrue(SyncRules.changed(10, 20, 3, 11, 20, 3))
        assertTrue(SyncRules.changed(10, 20, 3, 10, 21, 3))
        assertTrue(SyncRules.changed(10, 20, 3, 10, 20, 4))
    }

    @Test
    fun aScanAddsChangesAndDropsIndexEntries() {
        val indexed = mapOf(
            1L to Version(1, 10, 100, 1),
            2L to Version(2, 20, 200, 1),
            3L to Version(3, 30, 300, 1),
        )
        val scanned = listOf(Version(1, 10, 100, 1), Version(2, 20, 201, 2), Version(4, 40, 400, 1))
        assertEquals(Reconciled(added = listOf(4L), changed = listOf(2L), removed = listOf(3L)),
            SyncRules.reconcile(indexed, scanned))
        assertEquals(Reconciled(emptyList(), emptyList(), emptyList()), SyncRules.reconcile(indexed, indexed.values.toList()))
        assertEquals(Reconciled(emptyList(), emptyList(), listOf(1L, 2L, 3L)), SyncRules.reconcile(indexed, emptyList()))
    }

    @Test
    fun onlyAFailedItemPastItsBackoffIsDue() {
        assertTrue(SyncRules.due(ItemState.FAILED, 100, 100))
        assertFalse(SyncRules.due(ItemState.FAILED, 101, 100))
        assertFalse(SyncRules.due(ItemState.FAILED, Long.MAX_VALUE, 100))
        assertFalse(SyncRules.due(ItemState.PENDING, 0, 100))
    }

    @Test
    fun uploadAnswersMoveTheItem() {
        assertEquals(Answer.Finished, SyncRules.answer(200, 10, "imported"))
        assertEquals(Answer.Finished, SyncRules.answer(200, 10, "duplicate"))
        assertEquals(Answer.Progress(8), SyncRules.answer(200, 8, null))
        assertEquals(Answer.Resume(4), SyncRules.answer(409, 4, null))
        assertEquals(Answer.Resume(6), SyncRules.answer(400, 6, null))
        assertEquals(Answer.Restart, SyncRules.answer(422, 0, null))
        assertEquals(Answer.Fail(Reasons.UNREADABLE, true), SyncRules.answer(415, 0, null))
        assertEquals(Answer.Fail(Reasons.TOO_LARGE, true), SyncRules.answer(413, null, null))
        assertEquals(Answer.Fail(Reasons.REFUSED, false), SyncRules.answer(400, null, null))
    }

    @Test
    fun someAnswersStopTheWholeRun() {
        assertEquals(Answer.Stop(Phases.SIGNED_OUT, false), SyncRules.answer(401, null, null))
        assertEquals(Answer.Stop(Phases.UNAVAILABLE, false), SyncRules.answer(403, null, null))
        assertEquals(Answer.Stop(Phases.UNAVAILABLE, false), SyncRules.answer(302, null, null))
        assertEquals(Answer.Stop(Phases.SERVER_FULL, true), SyncRules.answer(507, 0, null))
        assertEquals(Answer.Stop(Phases.OFFLINE, true), SyncRules.answer(502, null, null))
        assertEquals(Answer.Stop(Phases.OFFLINE, true), SyncRules.answer(200, null, null))
        assertNull(SyncRules.runAnswer(200))
        assertEquals(Answer.Stop(Phases.SIGNED_OUT, false), SyncRules.runAnswer(401))
        assertEquals(Answer.Stop(Phases.UNAVAILABLE, false), SyncRules.runAnswer(404))
    }

    @Test
    fun onlyTheServersOwnOriginIsCalled() {
        assertEquals("https://home.example:8443", SyncRules.origin("https://Home.Example:8443"))
        assertEquals("http://10.0.2.2:18090", SyncRules.origin("http://10.0.2.2:18090/"))
        assertNull(SyncRules.origin("ftp://home.example"))
        assertNull(SyncRules.origin("https://user@home.example"))
        assertNull(SyncRules.origin("https://home.example/elsewhere"))
        assertNull(SyncRules.origin("https://home.example/?next=x"))
        assertNull(SyncRules.origin("not a url"))
    }

    @Test
    fun operationUrlsStayOnTheOriginAndRefuseOddRoutes() {
        assertEquals("https://h/api/satellites/media/backup/status",
            SyncRules.operationUrl("https://h", "media", "backup/status"))
        assertEquals("https://h/api/satellites/media/backup/upload/ab",
            SyncRules.operationUrl("https://h", "media", "backup/upload", "/ab"))
        assertFalse(SyncRules.validRoute("media", "../auth"))
        assertFalse(SyncRules.validRoute("media", "//evil.example/x"))
        assertFalse(SyncRules.validRoute("me/dia", "backup"))
        assertTrue(SyncRules.validDigest("a".repeat(64)))
        assertFalse(SyncRules.validDigest("A".repeat(64)))
    }

    @Test
    fun theUploadQueryIsEncoded() {
        assertEquals("offset=0&size=9&name=IMG%201.jpg&folder=DCIM%2FCamera&taken=1700000000",
            SyncRules.uploadQuery(0, 9, "IMG 1.jpg", "DCIM/Camera", 1_700_000_000))
        assertEquals("offset=3&size=9&name=a&folder=", SyncRules.uploadQuery(3, 9, "a", "", null))
    }

    @Test
    fun unknownStatesReadAsPending() {
        assertEquals(ItemState.DONE, ItemState.of("done"))
        assertEquals(ItemState.PENDING, ItemState.of("other"))
        assertEquals(ItemState.PENDING, ItemState.of(null))
    }
}
