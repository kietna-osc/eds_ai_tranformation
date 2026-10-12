/* Links the real History rows of 2026-10-08 to their images in Blob Storage.
   EDS-NotifySelected uploaded these images (POST /api/images) about 1 second before
   inserting each row; the blob path was kept only in image_blob_path, which the
   kietna schema dropped. Matched by upload time and checked by slip_no.
   Safe to run more than once. Run against eds-db in the Azure Portal Query editor. */

SET NOCOUNT ON;

UPDATE h
SET    image_url = v.image_url
FROM   dbo.history h
JOIN   (VALUES
    (CAST(61  AS BIGINT), N'1989-2173-2192', N'https://stedsimages1008.blob.core.windows.net/history-images/2026/10/ab2b9633-09ae-45d4-8803-1f1d688fead3.jpg'),
    (CAST(162 AS BIGINT), NULL,              N'https://stedsimages1008.blob.core.windows.net/history-images/2026/10/0b794618-7d39-4eb2-b2a9-c440ab0654df.jpg'),
    (CAST(163 AS BIGINT), NULL,              N'https://stedsimages1008.blob.core.windows.net/history-images/2026/10/6f3bdddb-087a-4769-9df5-af451bbb37c0.jpg'),
    (CAST(164 AS BIGINT), N'123',            N'https://stedsimages1008.blob.core.windows.net/history-images/2026/10/f1fc9c41-5859-4dea-820f-bddcf82f75ce.jpg'),
    (CAST(165 AS BIGINT), N'312',            N'https://stedsimages1008.blob.core.windows.net/history-images/2026/10/8c1eeb2e-0f6f-4765-bfd4-e8001e894c09.jpg'),
    (CAST(166 AS BIGINT), NULL,              N'https://stedsimages1008.blob.core.windows.net/history-images/2026/10/66345667-1bc7-40da-8d36-7b4c64099d61.jpg')
       ) v (history_id, slip_no, image_url)
    ON v.history_id = h.history_id
   AND (v.slip_no IS NULL OR v.slip_no = h.slip_no)
   AND CAST(h.created_at AS DATE) = '2026-10-08'
WHERE  h.image_url <> v.image_url;
PRINT CONCAT(@@ROWCOUNT, N' rows: image_url set to the blob URL');

SELECT history_id, slip_no, created_at, image_url
FROM   dbo.history
WHERE  history_id IN (61, 162, 163, 164, 165, 166)
ORDER  BY history_id;
