/* dbo.history.image_url holds the image's blob URL (kietna schema: no blob path columns).
   The Function derives the 320 px preview from it (<id>_preview.jpg next to the original).

   1. Rows that still have image_blob_path (if 01_schema.sql has not dropped it yet):
      image_url := blob URL. Run this before 01_schema.sql drops the column.
   2. PERFTEST-H rows (perftest_history_insert.sql stored image_url as NULL): image_url := their
      blob URL from that script.
   Safe to run more than once. Run against eds-db in the Azure Portal Query editor. */

SET NOCOUNT ON;

IF COL_LENGTH('dbo.history', 'image_blob_path') IS NOT NULL
    EXEC (N'UPDATE dbo.history
            SET    image_url = N''https://stedsimages1008.blob.core.windows.net/history-images/'' + image_blob_path
            WHERE  image_blob_path IS NOT NULL AND image_blob_path <> N''''
              AND  (image_url IS NULL OR image_url NOT LIKE N''https://stedsimages1008.blob.core.windows.net/history-images/%'');
            PRINT CONCAT(@@ROWCOUNT, N'' rows: image_url set from image_blob_path'');');

UPDATE h
SET    image_url = v.image_url
FROM   dbo.history h
JOIN   (VALUES
    (N'PERFTEST-H-001', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/0512e6b7-2a86-4660-8972-61b0deb0dac9.png'),
    (N'PERFTEST-H-002', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/24feaaca-ed9a-4014-8647-fa7fba6f2e8b.jpg'),
    (N'PERFTEST-H-003', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/5cc5411a-3783-4215-8cab-914c70978d10.png'),
    (N'PERFTEST-H-004', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/e9bfebd8-8f97-4dbe-8c9a-2cac9b2537cf.jpg'),
    (N'PERFTEST-H-005', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/1c96f847-8b57-4019-ae1e-d117779b8ff4.png'),
    (N'PERFTEST-H-006', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/9aa98e5d-bd92-44c5-a9b9-ca117e61abc1.jpg'),
    (N'PERFTEST-H-007', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/9cdecf79-0e85-4cd2-9e5f-336a64d16d71.png'),
    (N'PERFTEST-H-008', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/3ae35e1f-5e14-4e28-ae59-3f4e436ad78e.jpg'),
    (N'PERFTEST-H-009', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/a094cdd3-ee31-4223-bdbb-261436a6f9f0.png'),
    (N'PERFTEST-H-010', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/143bf0fc-3289-408d-bc10-bb741f6112b5.jpg'),
    (N'PERFTEST-H-011', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/95d41e1b-2665-46f9-a5e7-987ecf9aff6d.png'),
    (N'PERFTEST-H-012', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/e36cad56-790d-4cf6-b46a-c34e6a731351.jpg'),
    (N'PERFTEST-H-013', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/5a9d34d8-5d73-49e2-8b25-b4bca53ba74f.png'),
    (N'PERFTEST-H-014', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/5bd48432-0ad6-4da0-ad5b-59627157f3b0.jpg'),
    (N'PERFTEST-H-015', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/3203d655-49ba-4905-a84c-1796547ea305.png'),
    (N'PERFTEST-H-016', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/b0820899-ed84-4be0-aff7-ac87238ffd8c.jpg'),
    (N'PERFTEST-H-017', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/c5ef7a53-7d8f-46cb-8fcb-b184ea344550.png'),
    (N'PERFTEST-H-018', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/9bef7eb2-3b3f-40a1-926a-8f2138c48570.jpg'),
    (N'PERFTEST-H-019', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/2a53d235-ecc1-47e1-815e-45a36f878d37.png'),
    (N'PERFTEST-H-020', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/11f17b18-3722-4c50-ab7d-d3f8d2a04c86.jpg'),
    (N'PERFTEST-H-021', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/34a4e844-d8f8-4368-95ab-90d2c9f9721d.png'),
    (N'PERFTEST-H-022', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/5fbca182-a5cf-40be-8083-2a78cc110f58.jpg'),
    (N'PERFTEST-H-023', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/75e811b8-8228-4f14-837a-52c15527011b.png'),
    (N'PERFTEST-H-024', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/0b22a24b-eafa-449b-85c5-41617c0421a2.jpg'),
    (N'PERFTEST-H-025', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/02cc62dc-3b37-4c94-b625-b5c1f5e7cf47.png'),
    (N'PERFTEST-H-026', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/69ee0733-883c-452f-a418-3b8b6a85edf2.jpg'),
    (N'PERFTEST-H-027', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/ddf89037-e18e-4757-a594-4891aabcf606.png'),
    (N'PERFTEST-H-028', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/19ccf951-da1f-49e2-88e2-3f560aa94d2c.jpg'),
    (N'PERFTEST-H-029', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/52d1dbf4-5ef2-4402-9c57-eaa1815f94a5.png'),
    (N'PERFTEST-H-030', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/153d46f6-8405-4ed2-b659-ae558a02f9a0.jpg'),
    (N'PERFTEST-H-031', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/2cde5052-2475-492a-bc6b-cd59858753b5.png'),
    (N'PERFTEST-H-032', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/6b653db7-4a9c-4e37-9956-c5bfa8dcac07.jpg'),
    (N'PERFTEST-H-033', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/05a04680-2a9e-4b41-8b25-9ef3e165ce8f.png'),
    (N'PERFTEST-H-034', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/edfb1245-6bde-4cc8-a174-dd07b4ee3ecf.jpg'),
    (N'PERFTEST-H-035', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/2da5c5ba-7904-4b85-9614-0ba45beaf151.png'),
    (N'PERFTEST-H-036', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/3d86ed25-c490-4145-af7b-08bda66e077b.jpg'),
    (N'PERFTEST-H-037', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/4c2a1fc1-dec0-4fdd-9f4c-73cbbe173444.png'),
    (N'PERFTEST-H-038', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/e0a2065e-9b5e-4b7b-9b76-dc5043139c73.jpg'),
    (N'PERFTEST-H-039', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/5f4f6997-0464-4d3d-ba3c-ca5ae7824ad7.png'),
    (N'PERFTEST-H-040', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/f006c311-5422-460e-b474-227d08274138.jpg'),
    (N'PERFTEST-H-041', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/bf87af50-94e2-4178-8b95-36fb1be76d4f.png'),
    (N'PERFTEST-H-042', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/520515b8-601a-466f-89b0-53b6cff5e159.jpg'),
    (N'PERFTEST-H-043', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/0821f004-0eb2-4d06-84a1-33120c012495.png'),
    (N'PERFTEST-H-044', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/e149de1f-f31a-4a3f-b3f2-34ee99347cdb.jpg'),
    (N'PERFTEST-H-045', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/9c05bff7-bdac-460e-a35c-4d8a773b6100.png'),
    (N'PERFTEST-H-046', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/05254dfb-69e1-4a37-8e7b-af81cb33495a.jpg'),
    (N'PERFTEST-H-047', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/7fea0668-09d1-45c3-9f38-feef7b930e6e.png'),
    (N'PERFTEST-H-048', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/221a8da7-22b9-4917-8e84-b6bea5fc7d5a.jpg'),
    (N'PERFTEST-H-049', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/1e939487-2b8b-41a3-bd46-453fca2181b2.png'),
    (N'PERFTEST-H-050', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/4004705a-b371-4379-a260-cb667907d0ff.jpg'),
    (N'PERFTEST-H-051', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/67a74c1b-605f-474d-849f-ae4334dda9f1.png'),
    (N'PERFTEST-H-052', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/56bfb7a3-849f-4496-bb4b-3d0333ee4563.jpg'),
    (N'PERFTEST-H-053', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/c6461854-b842-4f05-a7f4-e740ab098c33.png'),
    (N'PERFTEST-H-054', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/2aa70eac-c485-4a1e-b700-fe0ab10d5a8d.jpg'),
    (N'PERFTEST-H-055', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/956503a5-4c90-4ba7-abaf-e0c528292001.png'),
    (N'PERFTEST-H-056', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/ee6a4c2f-d2b6-44ed-b2ad-e9a3cb490b41.jpg'),
    (N'PERFTEST-H-057', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/e3d15747-c94c-40ff-8548-33abb0570540.png'),
    (N'PERFTEST-H-058', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/dc8fc932-e3cf-4aee-9235-a0637d8d446d.jpg'),
    (N'PERFTEST-H-059', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/f039ac69-2591-4a88-a03f-d9e4443eea91.png'),
    (N'PERFTEST-H-060', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/2a283a2d-ccf1-414b-8848-2c1dc6157f14.jpg'),
    (N'PERFTEST-H-061', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/d4364366-fbfe-4fc3-a32d-201b32d9c318.png'),
    (N'PERFTEST-H-062', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/72aa1144-035c-4e35-b125-e8f7fdac2d2a.jpg'),
    (N'PERFTEST-H-063', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/0b07012e-4968-4010-ab24-b1aac6223334.png'),
    (N'PERFTEST-H-064', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/ab26aa89-5a93-47d6-90f8-ebef64000944.jpg'),
    (N'PERFTEST-H-065', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/0eda3191-e9ce-4735-b317-05bc06a08848.png'),
    (N'PERFTEST-H-066', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/67473933-bf3a-4c21-ac63-3d4993e34e31.jpg'),
    (N'PERFTEST-H-067', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/c9cfeb02-019f-456d-9b97-0e7453071635.png'),
    (N'PERFTEST-H-068', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/2f424400-763d-44b3-a6b9-4adb03417622.jpg'),
    (N'PERFTEST-H-069', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/70a7f05b-0f14-41ba-a74a-454d2a9656bf.png'),
    (N'PERFTEST-H-070', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/e8ba5396-13da-485d-b51b-c7e62bae0bb2.jpg'),
    (N'PERFTEST-H-071', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/40356cc2-9d1a-4505-b226-6c7bc96d54a2.png'),
    (N'PERFTEST-H-072', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/645a1fbe-c37d-4205-932f-aa4eeb1e33b4.jpg'),
    (N'PERFTEST-H-073', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/e6572339-1eff-445b-aa18-62966082706a.png'),
    (N'PERFTEST-H-074', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/43e1a81d-d15e-4e4b-bc95-74c98651a18b.jpg'),
    (N'PERFTEST-H-075', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/2201c8f0-413e-4bdc-b9e3-e6a56618888f.png'),
    (N'PERFTEST-H-076', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/9dccacb8-a1e3-4568-98dd-f1f5c07c05a2.jpg'),
    (N'PERFTEST-H-077', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/07e4351d-f6a6-4809-a1a6-34379f65f683.png'),
    (N'PERFTEST-H-078', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/83bda1af-6757-4859-83ce-0c5851f081dd.jpg'),
    (N'PERFTEST-H-079', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/cf701626-a3e9-4952-ab84-ba6d77c5b619.png'),
    (N'PERFTEST-H-080', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/aa41c60a-f049-40b0-b21e-21e6b60e1310.jpg'),
    (N'PERFTEST-H-081', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/2fe18226-911e-47f2-a387-8c9d05a915e7.png'),
    (N'PERFTEST-H-082', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/7fcaf1ac-9fb8-4085-9a46-ec76f12d04cc.jpg'),
    (N'PERFTEST-H-083', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/d7767791-f29d-4c95-9e87-c933f8e1dc31.png'),
    (N'PERFTEST-H-084', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/e0565c7e-7630-4fdb-83df-5e8defc45a2b.jpg'),
    (N'PERFTEST-H-085', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/03aa78d8-b570-41ef-b8d3-f8d1d89b6106.png'),
    (N'PERFTEST-H-086', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/745ec8a8-8847-41d8-80c7-3d6f8c419793.jpg'),
    (N'PERFTEST-H-087', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/09ffec6a-5f3f-42d4-8272-2097c0604e9e.png'),
    (N'PERFTEST-H-088', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/5cd99b22-ed5f-4b88-a7ae-734788e8ffb3.jpg'),
    (N'PERFTEST-H-089', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/83d528dc-3eb2-450e-8ddd-68696c9f60dc.png'),
    (N'PERFTEST-H-090', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/5f5b91d3-3964-446e-8c73-2ab3c8fdff8e.jpg'),
    (N'PERFTEST-H-091', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/bcf96f19-9cee-413b-a6be-67571f201f3b.png'),
    (N'PERFTEST-H-092', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/0273e332-b203-4270-8a42-b0da77f92f5b.jpg'),
    (N'PERFTEST-H-093', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/63deb433-e322-49a1-b181-2f776e8e714c.png'),
    (N'PERFTEST-H-094', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/c0654fba-794e-46ca-86e0-29cc3c26838f.jpg'),
    (N'PERFTEST-H-095', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/bab85d81-86bf-42a9-8a6a-8db2965643f0.png'),
    (N'PERFTEST-H-096', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/e7ffd86c-04f2-4427-a371-be174c5fb429.jpg'),
    (N'PERFTEST-H-097', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/bf85aae7-66fd-4583-b4e8-731c506ca61a.png'),
    (N'PERFTEST-H-098', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/d5b0a032-6982-4541-8c3a-200dd6f8b8a7.jpg'),
    (N'PERFTEST-H-099', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/4f37062c-1839-44ed-9e52-0ca9fcc3459f.png'),
    (N'PERFTEST-H-100', N'https://stedsimages1008.blob.core.windows.net/history-images/perftest/2026/10/37e0c1f8-834c-4ea3-9c2d-557c3b8f7dfb.jpg')
       ) v (slip_no, image_url) ON v.slip_no = h.slip_no
WHERE  ISNULL(h.image_url, N'') <> v.image_url;
PRINT CONCAT(@@ROWCOUNT, N' PERFTEST rows: image_url set');

SELECT COUNT(*) AS total_rows,
       SUM(CASE WHEN image_url LIKE N'https://stedsimages1008.blob.core.windows.net/history-images/%' THEN 1 ELSE 0 END) AS blob_rows,
       SUM(CASE WHEN image_url LIKE N'http%' AND image_url NOT LIKE N'https://stedsimages1008.blob.core.windows.net/history-images/%' THEN 1 ELSE 0 END) AS other_url_rows,
       SUM(CASE WHEN ISNULL(image_url, N'') = N'' THEN 1 ELSE 0 END) AS empty_rows
FROM   dbo.history;
