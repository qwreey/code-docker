import type { DindImage } from '../../api/types'

export function ImageTable({ images }: { images: DindImage[] }) {
  if (images.length === 0) {
    return <p className="empty-state">dind에 이미지가 없습니다.</p>
  }

  return (
    <div className="table-wrapper">
      <table className="process-info-table">
        <thead>
          <tr>
            <th>저장소</th>
            <th>태그</th>
            <th>ID</th>
            <th>크기</th>
            <th>생성</th>
          </tr>
        </thead>
        <tbody>
          {images.map((img) => (
            <tr key={img.id}>
              <td>{img.repository}</td>
              <td>{img.tag}</td>
              <td>{img.id.slice(0, 12)}</td>
              <td>{img.size}</td>
              <td>{img.created}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
